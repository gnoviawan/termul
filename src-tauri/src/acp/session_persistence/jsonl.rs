use super::*;

/// Lightweight corruption check: read the first line of a JSONL file and
/// verify it deserializes as a `PersistedEventRecord` with the expected
/// schema version and session id. Returns `true` for empty files or valid
/// first records, `false` only when the first line is non-empty and
/// unparseable or mismatches. This catches fully-corrupt files without
/// loading all records.
pub(super) fn jsonl_first_record_is_valid(path: &Path, expected_session_id: &str) -> bool {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return true, // missing file is handled by `ensure_log_exists`
    };
    use std::io::BufRead;
    let reader = std::io::BufReader::new(file);
    match reader.lines().next() {
        Some(Ok(line)) if !line.trim().is_empty() => {
            match serde_json::from_str::<PersistedEventRecord>(&line) {
                Ok(record) => {
                    record.schema_version == SESSION_SCHEMA_VERSION
                        && record.session_id == expected_session_id
                }
                Err(_) => false,
            }
        }
        _ => true, // empty file or no lines — not corrupt
    }
}

/// Repair a torn final tail (incomplete write at the end of a JSONL file)
/// by reading only the last 4 KiB, finding the last newline, and truncating
/// any unparseable trailing bytes. This is O(1) per file — it never reads
/// the full transcript — and prevents later appends from landing after a
/// torn line (which would make `replay_after` return `CorruptSession`).
pub(super) fn repair_jsonl_torn_tail(path: &Path) {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = match fs::OpenOptions::new().read(true).write(true).open(path) {
        Ok(f) => f,
        Err(_) => return, // missing file is handled by `ensure_log_exists`
    };
    let file_size = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return,
    };
    if file_size == 0 {
        return;
    }
    // Read the last 4 KiB (or entire file if smaller).
    let block = std::cmp::min(file_size, 4096) as usize;
    let start = file_size - block as u64;
    if file.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    let mut buf = vec![0u8; block];
    if file.read_exact(&mut buf).is_err() {
        return;
    }
    // Data after the last newline is the (possibly torn) tail.
    let last_nl = buf.iter().rposition(|&b| b == b'\n');
    let (valid_end, tail): (u64, &[u8]) = match last_nl {
        Some(pos) if pos + 1 < buf.len() => (start + pos as u64 + 1, &buf[pos + 1..]),
        Some(_) => return,     // file ends with newline — no tail
        None => (0, &buf[..]), // no newline — entire block is tail
    };
    if tail.is_empty() || tail.iter().all(|b| b.is_ascii_whitespace()) {
        return;
    }
    // If the tail deserializes as a valid record, it is just missing a
    // trailing newline — not torn, leave it for the next append to terminate.
    if serde_json::from_slice::<PersistedEventRecord>(tail).is_ok() {
        return;
    }
    // Torn tail — backup and truncate.
    let _ = atomic_file::backup_corrupt(path, tail);
    let _ = file.set_len(valid_end);
}

pub(super) fn decode_index(bytes: &[u8]) -> Result<SessionIndexFile> {
    decode_versioned(bytes)
}

pub(super) fn decode_versioned<T>(bytes: &[u8]) -> Result<T>
where
    T: for<'de> Deserialize<'de>,
{
    let value: Value = serde_json::from_slice(bytes)?;
    let version = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or(SessionPersistenceError::CorruptSession)?;
    if version == u64::from(SESSION_SCHEMA_VERSION) {
        Ok(serde_json::from_value(value)?)
    } else {
        Err(SessionPersistenceError::UnsupportedVersion { found: version })
    }
}

pub(super) fn load_jsonl(
    path: &Path,
    session_id: &str,
    repair_torn_tail: bool,
) -> Result<Vec<PersistedEventRecord>> {
    let bytes = fs::read(path)?;
    let mut records = Vec::new();
    let mut offset = 0usize;
    while offset < bytes.len() {
        let remainder = &bytes[offset..];
        let newline = remainder.iter().position(|byte| *byte == b'\n');
        let (line, next_offset, terminated) = match newline {
            Some(position) => (&remainder[..position], offset + position + 1, true),
            None => (remainder, bytes.len(), false),
        };
        if line.is_empty() {
            offset = next_offset;
            continue;
        }
        match serde_json::from_slice::<PersistedEventRecord>(line) {
            Ok(record)
                if record.schema_version == SESSION_SCHEMA_VERSION
                    && record.session_id == session_id =>
            {
                records.push(record)
            }
            Ok(_) => return Err(SessionPersistenceError::CorruptSession),
            Err(_) if repair_torn_tail && !terminated && next_offset == bytes.len() => {
                let _ = atomic_file::backup_corrupt(path, &bytes);
                atomic_file::replace(path, &bytes[..offset])?;
                break;
            }
            Err(_) => return Err(SessionPersistenceError::CorruptSession),
        }
        offset = next_offset;
    }
    Ok(records)
}

/// Result of [`load_jsonl_tail`]: the parsed tail records plus whether the
/// window reached the file head. `reached_head` is true when no earlier
/// records exist — i.e. the loaded slice is the whole file — which the
/// caller needs to decide if a `message_chunk` at the window edge starts a
/// fresh fold run or continues an unloaded one.
pub(super) struct TailSlice {
    pub(super) records: Vec<PersistedEventRecord>,
    pub(super) reached_head: bool,
}

/// Read only the last `max_lines` newline-terminated records from a JSONL
/// file. Seeks backward from the file end in bounded blocks (4 KiB) until
/// `max_lines` complete records are located, then reads and deserializes
/// only the resulting byte range. This avoids reading the entire file for
/// long transcripts. Returns records in file order (seq order for a
/// well-formed session).
///
/// Only the final unterminated line (no trailing newline, possibly
/// mid-write) is tolerated. Any malformed or session/schema-mismatched
/// newline-terminated line propagates as `CorruptSession` — matching
/// `load_jsonl`'s fail-closed behavior so a corrupt file never yields a
/// partial tail payload.
pub(super) fn load_jsonl_tail(
    path: &Path,
    session_id: &str,
    max_lines: usize,
) -> Result<TailSlice> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = fs::File::open(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            return SessionPersistenceError::SessionNotFound;
        }
        SessionPersistenceError::Io(error)
    })?;

    let file_len = file.metadata()?.len();
    if file_len == 0 {
        return Ok(TailSlice {
            records: Vec::new(),
            reached_head: true,
        });
    }

    // Seek backward in 4 KiB blocks, counting newlines until we have
    // `max_lines` complete records or reach the file start.
    const BLOCK: usize = 4 * 1024;
    let mut newline_count = 0usize;
    let mut tail_start = file_len as usize;
    let mut buf = Vec::with_capacity(BLOCK);

    while tail_start > 0 && newline_count < max_lines {
        let read_start = tail_start.saturating_sub(BLOCK);
        let read_len = tail_start - read_start;
        file.seek(SeekFrom::Start(read_start as u64))?;
        buf.clear();
        buf.resize(read_len, 0);
        file.read_exact(&mut buf)?;

        // Count newlines in this block (backward).
        for &byte in buf.iter().rev() {
            if byte == b'\n' {
                newline_count += 1;
                if newline_count >= max_lines {
                    break;
                }
            }
        }
        tail_start = read_start;
    }

    // `tail_start` is now the offset of the block containing the max_lines-th
    // newline from the end. Read from the byte AFTER that newline to the file
    // end. If we ran out of newlines (file has fewer than max_lines), read
    // from offset 0.
    let read_offset = if newline_count >= max_lines {
        // Find the (newline_count - max_lines + 1)-th newline from the end of
        // the accumulated data. Since we scanned backward, the first newline
        // we hit is the last in the file, etc. We need the position of the
        // max_lines-th newline from the end, then start reading after it.
        // Re-scan the accumulated range to find the exact offset.
        let full_start = tail_start;
        let full_len = file_len as usize - full_start;
        file.seek(SeekFrom::Start(full_start as u64))?;
        let mut full_buf = vec![0u8; full_len];
        file.read_exact(&mut full_buf)?;
        // Count newlines from the end to find the max_lines-th.
        let mut nl_from_end = 0usize;
        let mut content_start = 0usize;
        for (i, &byte) in full_buf.iter().enumerate().rev() {
            if byte == b'\n' {
                nl_from_end += 1;
                if nl_from_end == max_lines {
                    content_start = full_start + i + 1;
                    break;
                }
            }
        }
        content_start
    } else {
        0
    };

    // Read the tail byte range and deserialize line by line.
    let tail_len = file_len as usize - read_offset;
    if tail_len == 0 {
        return Ok(TailSlice {
            records: Vec::new(),
            reached_head: true,
        });
    }
    // `read_offset == 0` means the backward scan consumed the whole file:
    // the returned slice IS the complete record log.
    let reached_head = read_offset == 0;
    file.seek(SeekFrom::Start(read_offset as u64))?;
    let mut tail_bytes = vec![0u8; tail_len];
    file.read_exact(&mut tail_bytes)?;

    let mut records = Vec::new();
    let mut offset = 0usize;
    while offset < tail_bytes.len() {
        let remainder = &tail_bytes[offset..];
        let newline = remainder.iter().position(|byte| *byte == b'\n');
        let (line, next_offset, terminated) = match newline {
            Some(position) => (&remainder[..position], offset + position + 1, true),
            None => (remainder, tail_bytes.len(), false),
        };
        if line.is_empty() {
            offset = next_offset;
            continue;
        }
        let is_final_unterminated = !terminated && next_offset == tail_bytes.len();
        match serde_json::from_slice::<PersistedEventRecord>(line) {
            Ok(record)
                if record.schema_version == SESSION_SCHEMA_VERSION
                    && record.session_id == session_id =>
            {
                records.push(record)
            }
            Ok(_) => return Err(SessionPersistenceError::CorruptSession),
            Err(_) if is_final_unterminated => {
                // A torn final line (no trailing newline, possibly mid-write)
                // is tolerated — skip it so a concurrent writer can't crash
                // the tail read. Matches `load_jsonl`'s repair_torn_tail.
                break;
            }
            Err(_) => return Err(SessionPersistenceError::CorruptSession),
        }
        offset = next_offset;
    }
    Ok(TailSlice {
        records,
        reached_head,
    })
}
