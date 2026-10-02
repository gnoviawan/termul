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

/// Durable-frontier probe used by `recover()`: read backward from the end
/// of a JSONL log in growing blocks (4 KiB → 4 MiB cap) until the window
/// covers at least one complete newline-terminated line, then return the
/// highest seq among the tail records that parse for
/// `session_id`/`SESSION_SCHEMA_VERSION` — on a well-formed log that is
/// simply the last record's seq (records append under a single monotonic
/// counter). This is how far `metadata.json` actually lagged the log after
/// a crash: a tail seq above the persisted `last_seq` proves the durable
/// frontier advanced past what the seq allocator would otherwise trust, so
/// the next append would reuse a seq. The window must deepen because a
/// single record can exceed a fixed 4 KiB read — payloads pass through
/// verbatim — and a window holding only a mid-record fragment would
/// otherwise leave stale-low `last_seq` in place. Missing/empty files and
/// tails with no complete own-session record inside the cap yield `None`
/// (the caller leaves `last_seq` unchanged); real read errors are
/// warn-logged here. This is a frontier probe, not a validator — it never
/// scans past the cap and never fails.
pub(super) fn jsonl_tail_seq(path: &Path, session_id: &str) -> Option<u64> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) => {
            if error.kind() != io::ErrorKind::NotFound {
                log::warn!(
                    "[acp-history] tail seq probe failed path={} session_id={} error={error}",
                    path.display(),
                    crate::logging::redact_session_id(session_id)
                );
            }
            return None;
        }
    };
    let file_size = match file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(error) => {
            log::warn!(
                "[acp-history] tail seq probe failed path={} session_id={} error={error}",
                path.display(),
                crate::logging::redact_session_id(session_id)
            );
            return None;
        }
    };
    if file_size == 0 {
        return None;
    }
    const BLOCK: u64 = 4 * 1024;
    const PROBE_CAP: u64 = 4 * 1024 * 1024;
    let mut block = std::cmp::min(file_size, BLOCK);
    loop {
        let start = file_size - block;
        let mut buf = vec![0u8; block as usize];
        let read = file
            .seek(SeekFrom::Start(start))
            .and_then(|_| file.read_exact(&mut buf));
        if let Err(error) = read {
            log::warn!(
                "[acp-history] tail seq probe failed path={} session_id={} error={error}",
                path.display(),
                crate::logging::redact_session_id(session_id)
            );
            return None;
        }
        // Only newline-terminated lines count: bytes after the last '\n'
        // are an unterminated tail fragment (torn write — the torn-tail
        // repair already ran, so this is defensive), and a line beginning
        // at buf[0] is a mid-record fragment unless the block reached the
        // file start.
        let mut max_seq = None;
        let mut saw_complete = false;
        let mut offset = 0usize;
        while offset < buf.len() {
            let remainder = &buf[offset..];
            let newline = remainder.iter().position(|byte| *byte == b'\n');
            let (line, terminated, next_offset) = match newline {
                Some(position) => (&remainder[..position], true, offset + position + 1),
                None => (remainder, false, buf.len()),
            };
            let complete = terminated && (offset > 0 || start == 0);
            offset = next_offset;
            if !complete || line.is_empty() {
                continue;
            }
            saw_complete = true;
            if let Ok(record) = serde_json::from_slice::<PersistedEventRecord>(line) {
                if record.schema_version == SESSION_SCHEMA_VERSION
                    && record.session_id == session_id
                {
                    max_seq = Some(max_seq.unwrap_or(0).max(record.seq));
                }
            }
        }
        if saw_complete || block == file_size || block >= PROBE_CAP {
            return max_seq;
        }
        block = std::cmp::min(file_size, std::cmp::min(block * 8, PROBE_CAP));
    }
}

/// Healed-file recount produced by [`salvage_session_dir`]: the durable
/// totals the catalog metadata must agree with after intruders are
/// removed.
pub(super) struct SalvageCounts {
    pub(super) message_count: u64,
    pub(super) tool_count: u64,
    pub(super) last_seq: u64,
    /// Quarantined lines — for the heal log; the bytes live in the
    /// `.corrupt-*.bak` sidecar.
    pub(super) intruder_lines: u64,
}

/// Per-file result of [`scan_seq_intruders`].
struct SeqIntruderScan {
    /// File bytes minus the intruder lines; everything else preserved
    /// verbatim (line order, blank lines, the final-newline state).
    kept: Vec<u8>,
    /// Removed intruder lines verbatim — quarantined to `.corrupt-*.bak`.
    intruders: Vec<u8>,
    intruder_lines: u64,
    /// Kept records in file order, for the metadata recount.
    kept_records: Vec<PersistedEventRecord>,
}

/// Single file-order pass over JSONL bytes classifying each line: a record
/// that parses, matches `session_id`/`SESSION_SCHEMA_VERSION`, and has
/// `seq >` the running max is kept; a matching record with `seq <=` the
/// running max (which also covers `seq == 0`, since the max starts at 0)
/// is a seq intruder — the post-crash stale-`last_seq` append signature —
/// and is collected for quarantine. Returns `None` when any non-empty line
/// is unparseable mid-file or any record is foreign (wrong session/schema)
/// — those stay `CorruptSession` and are never dropped by the salvage
/// path.
fn scan_seq_intruders(bytes: &[u8], session_id: &str) -> Option<SeqIntruderScan> {
    let mut scan = SeqIntruderScan {
        kept: Vec::with_capacity(bytes.len()),
        intruders: Vec::new(),
        intruder_lines: 0,
        kept_records: Vec::new(),
    };
    let mut running_max = 0u64;
    let mut offset = 0usize;
    while offset < bytes.len() {
        let remainder = &bytes[offset..];
        let newline = remainder.iter().position(|byte| *byte == b'\n');
        let (line, terminated, next_offset) = match newline {
            Some(position) => (&remainder[..position], true, offset + position + 1),
            None => (remainder, false, bytes.len()),
        };
        let raw = &bytes[offset..next_offset];
        offset = next_offset;
        if line.is_empty() {
            // Blank lines are preserved verbatim — they carry no record.
            scan.kept.extend_from_slice(raw);
            continue;
        }
        match serde_json::from_slice::<PersistedEventRecord>(line) {
            Ok(record)
                if record.schema_version == SESSION_SCHEMA_VERSION
                    && record.session_id == session_id =>
            {
                if record.seq <= running_max {
                    // Seq intruder — keeping the FIRST occurrence preserves
                    // original chronology.
                    scan.intruders.extend_from_slice(raw);
                    scan.intruder_lines += 1;
                } else {
                    running_max = record.seq;
                    scan.kept.extend_from_slice(raw);
                    scan.kept_records.push(record);
                }
            }
            Err(_) if !terminated && next_offset == bytes.len() => {
                // An unterminated, unparseable FINAL line is the same shape
                // `repair_jsonl_torn_tail` truncates at startup — a torn
                // write, not evidence against the rest of the file.
                // Quarantine its bytes instead of failing the heal.
                scan.intruders.extend_from_slice(raw);
                scan.intruder_lines += 1;
            }
            // Unparseable mid-file or foreign-session/schema lines stay
            // CorruptSession: the file is not salvageable here.
            _ => return None,
        }
    }
    // The rewrite must leave the file newline-terminated, or the next
    // append lands on the same line as the last kept record.
    if !scan.kept.is_empty() && !scan.kept.ends_with(b"\n") {
        scan.kept.push(b'\n');
    }
    Some(scan)
}

/// Unlocked pre-check for the read-path salvage: `true` only when every
/// scanned log is salvageable AND at least one holds an intruder — i.e. a
/// locked [`salvage_session_dir`] pass could actually rewrite something.
/// Unsalvageable content (`None` from [`scan_seq_intruders`]) and clean
/// logs both return `false`, so permanently-corrupt sessions never reach
/// for the catalog lock on every failed read.
pub(super) fn has_seq_intruders(dir: &Path, session_id: &str) -> Result<bool> {
    for name in [MESSAGES_FILE, TOOL_CALLS_FILE] {
        let path = dir.join(name);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if bytes.is_empty() {
            continue;
        }
        match scan_seq_intruders(&bytes, session_id) {
            None => return Ok(false),
            Some(scan) if !scan.intruders.is_empty() => return Ok(true),
            _ => {}
        }
    }
    Ok(false)
}

/// Single file-order salvage pass over a session directory's JSONL logs.
/// On `Ok(Some(_))` every intruder line was moved to a `.corrupt-*.bak`
/// sidecar (all backups complete before any rewrite) and each affected
/// file was atomically rewritten without it; the returned counts describe
/// the healed logs so the caller can re-sync catalog metadata. `Ok(None)`
/// means either nothing needed healing or some line was unsalvageable — in
/// both cases no file was rewritten.
pub(super) fn salvage_session_dir(dir: &Path, session_id: &str) -> Result<Option<SalvageCounts>> {
    let mut staged: Vec<(PathBuf, Vec<u8>, Vec<u8>)> = Vec::new();
    let mut counts = SalvageCounts {
        message_count: 0,
        tool_count: 0,
        last_seq: 0,
        intruder_lines: 0,
    };
    let mut salvageable = true;
    // Seqs must be unique across BOTH logs once healed — `validate_and_sort`
    // merges them. A file can be internally monotonic yet still collide with
    // the other log's kept seqs (the post-crash writer interleaves both
    // files); rewriting in that state would violate the no-rewrite-unless-
    // healed contract, so the heal bails before staging any change.
    let mut kept_seqs = std::collections::HashSet::new();
    for name in [MESSAGES_FILE, TOOL_CALLS_FILE] {
        let path = dir.join(name);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if bytes.is_empty() {
            continue;
        }
        let Some(scan) = scan_seq_intruders(&bytes, session_id) else {
            salvageable = false;
            break;
        };
        for record in &scan.kept_records {
            if !kept_seqs.insert(record.seq) {
                salvageable = false;
                break;
            }
            if is_tool_event(&record.type_) {
                counts.tool_count += 1;
            } else if record.type_ != "agent_switch" {
                // CAP-2: a switch marker is a transcript boundary, not a
                // message — same counting rule as `append_record`.
                counts.message_count += 1;
            }
            counts.last_seq = counts.last_seq.max(record.seq);
        }
        if !salvageable {
            break;
        }
        counts.intruder_lines += scan.intruder_lines;
        if !scan.intruders.is_empty() {
            staged.push((path, scan.kept, scan.intruders));
        }
    }
    if !salvageable || staged.is_empty() {
        return Ok(None);
    }
    // Quarantine every intruder BEFORE any rewrite: a backup failure must
    // never leave a partially-rewritten log without its `.corrupt-*.bak`.
    for (path, _, intruders) in &staged {
        atomic_file::backup_corrupt(path, intruders)?;
    }
    for (path, kept, _) in &staged {
        atomic_file::replace(path, kept)?;
    }
    Ok(Some(counts))
}
