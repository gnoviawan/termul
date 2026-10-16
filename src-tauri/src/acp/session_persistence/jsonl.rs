use std::ops::ControlFlow;
use std::sync::LazyLock;

use memchr::memmem;

use super::*;

/// Envelope-only view of a JSONL record: the fields the startup checks need,
/// without materializing the payload (a `commands_update` payload alone can
/// run to 100 KB). It requires the same envelope fields as a
/// `PersistedEventRecord` parse, but skipped payload bytes are only
/// tokenized, not validated as `Value` (invalid UTF-8 or a lone `\u`
/// surrogate inside a skipped string passes). That is enough for the
/// startup checks: a record they accept that `load_jsonl` later rejects is
/// still caught, salvaged or quarantined by the read paths.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RecordProbe {
    schema_version: u32,
    session_id: String,
    pub(super) seq: u64,
    #[serde(rename = "type")]
    pub(super) type_: String,
    /// Required like `PersistedEventRecord::recorded_at`, so the probe
    /// rejects the same lines; never read.
    #[serde(rename = "recordedAt")]
    _recorded_at: u64,
    pub(super) payload: PayloadProbe,
}

/// `payload.turnId` of a probed record (the only payload field the open-turn
/// fold reads); every other payload byte is skipped unparsed.
#[derive(Default)]
pub(super) struct PayloadProbe {
    pub(super) turn_id: Option<Value>,
}

impl<'de> Deserialize<'de> for PayloadProbe {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        use serde::de::{IgnoredAny, MapAccess, SeqAccess, Visitor};

        struct ProbeVisitor;
        impl<'de> Visitor<'de> for ProbeVisitor {
            type Value = PayloadProbe;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a JSON value")
            }

            // Same lookup as `Value::get("turnId")`: only an object has one,
            // and a repeated key keeps its last value.
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<PayloadProbe, A::Error> {
                let mut probe = PayloadProbe::default();
                while let Some(key) = map.next_key::<String>()? {
                    if key == "turnId" {
                        probe.turn_id = Some(map.next_value::<Value>()?);
                    } else {
                        map.next_value::<IgnoredAny>()?;
                    }
                }
                Ok(probe)
            }

            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<PayloadProbe, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(PayloadProbe::default())
            }

            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<PayloadProbe, E> {
                Ok(PayloadProbe::default())
            }

            fn visit_bool<E: serde::de::Error>(
                self,
                _: bool,
            ) -> std::result::Result<PayloadProbe, E> {
                Ok(PayloadProbe::default())
            }

            fn visit_i64<E: serde::de::Error>(
                self,
                _: i64,
            ) -> std::result::Result<PayloadProbe, E> {
                Ok(PayloadProbe::default())
            }

            fn visit_u64<E: serde::de::Error>(
                self,
                _: u64,
            ) -> std::result::Result<PayloadProbe, E> {
                Ok(PayloadProbe::default())
            }

            fn visit_f64<E: serde::de::Error>(
                self,
                _: f64,
            ) -> std::result::Result<PayloadProbe, E> {
                Ok(PayloadProbe::default())
            }

            fn visit_str<E: serde::de::Error>(
                self,
                _: &str,
            ) -> std::result::Result<PayloadProbe, E> {
                Ok(PayloadProbe::default())
            }
        }

        deserializer.deserialize_any(ProbeVisitor)
    }
}

/// Probe one JSONL line: `Some` only when it parses and belongs to
/// `session_id` under [`SESSION_SCHEMA_VERSION`].
pub(super) fn probe_record(line: &[u8], session_id: &str) -> Option<RecordProbe> {
    serde_json::from_slice::<RecordProbe>(line)
        .ok()
        .filter(|probe| {
            probe.schema_version == SESSION_SCHEMA_VERSION && probe.session_id == session_id
        })
}

/// Read sizes of [`scan_lines_backward`]: the first read is small so probing
/// one line stays cheap, and each further read doubles up to the cap so a
/// long pass takes few reads.
const BACKWARD_FIRST_BLOCK: u64 = 16 * 1024;
const BACKWARD_MAX_BLOCK: u64 = 1024 * 1024;

/// Visit the non-empty lines of `file[floor..end)` from the last one back
/// toward `floor`, reading every byte once (a line that spans reads is
/// carried, never re-read). `visit` gets the line without its `\n` and
/// whether it is newline-terminated (only the last line can be bare), and
/// stops the pass with `Break`. `floor` must be 0 or a line start. Returns
/// the bytes read.
pub(super) fn scan_lines_backward(
    file: &mut fs::File,
    end: u64,
    floor: u64,
    mut visit: impl FnMut(&[u8], bool) -> ControlFlow<()>,
) -> io::Result<u64> {
    use std::io::{Read, Seek, SeekFrom};

    // `buf` holds the not-yet-visited bytes `[buf_start, buf_start + len)`.
    let mut buf: Vec<u8> = Vec::new();
    let mut buf_start = end;
    let mut block = BACKWARD_FIRST_BLOCK;
    let mut bytes_read = 0u64;
    loop {
        let line_end = buf_start + buf.len() as u64;
        let (line_start, line) = match memchr::memrchr(b'\n', &buf) {
            Some(newline) => (newline + 1, &buf[newline + 1..]),
            None if buf_start > floor => {
                // The line continues before the buffer: read the previous
                // block (at least the carried length, so a long line costs
                // amortized O(len)) and prepend it.
                let want = block.max(buf.len() as u64).min(buf_start - floor);
                let mut joined = vec![0u8; want as usize + buf.len()];
                file.seek(SeekFrom::Start(buf_start - want))?;
                file.read_exact(&mut joined[..want as usize])?;
                joined[want as usize..].copy_from_slice(&buf);
                buf = joined;
                buf_start -= want;
                bytes_read += want;
                block = (block * 2).min(BACKWARD_MAX_BLOCK);
                continue;
            }
            None => (0, &buf[..]),
        };
        if !line.is_empty() && visit(line, line_end < end).is_break() {
            return Ok(bytes_read);
        }
        if line_start == 0 {
            return Ok(bytes_read);
        }
        buf.truncate(line_start - 1);
    }
}

/// The last non-empty line of `file[..end)`, probed, when the byte before
/// `end` is its `\n`. `None` when that line is bare, unparseable or foreign.
pub(super) fn probe_line_ending_at(
    file: &mut fs::File,
    end: u64,
    session_id: &str,
) -> io::Result<Option<RecordProbe>> {
    let mut probe = None;
    scan_lines_backward(file, end, 0, |line, terminated| {
        if terminated {
            probe = probe_record(line, session_id);
        }
        ControlFlow::Break(())
    })?;
    Ok(probe)
}

/// Exact `type` of the three records the open-turn fold reads, as the writer
/// serializes them. A nested `"type"` key inside a payload can also match;
/// the probe of the top-level `type` sorts those out.
static FOLD_TYPE_NEEDLES: LazyLock<[memmem::Finder<'static>; 3]> = LazyLock::new(|| {
    [
        memmem::Finder::new(b"\"type\":\"user_prompt\""),
        memmem::Finder::new(b"\"type\":\"agent_switch\""),
        memmem::Finder::new(b"\"type\":\"prompt_complete\""),
    ]
});

/// Result of [`scan_fold_tail`].
pub(super) struct FoldTailScan {
    /// Fold records from the end of the log back to (and including) the
    /// newest `user_prompt`/`agent_switch` boundary, newest first.
    pub(super) records: Vec<RecordProbe>,
    /// A candidate line did not probe: the fold is unknown.
    pub(super) unreadable: bool,
    pub(super) bytes_read: u64,
    pub(super) last_line: Option<LastLine>,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct LastLine {
    pub(super) seq: u64,
    pub(super) terminated: bool,
}

impl FoldTailScan {
    pub(super) fn open_turn(&self) -> Option<Option<&Value>> {
        self.records.iter().rev().fold(None, |pending, record| {
            open_turn_step(pending, &record.type_, record.payload.turn_id.as_ref())
        })
    }
}

/// One backward pass over `file[floor..end)` collecting the records the
/// open-turn fold needs. Only candidate lines (a memmem hit on a fold type)
/// and the last line are parsed, and only with [`RecordProbe`]. The pass
/// stops at the newest `user_prompt` or `agent_switch` (every later record is
/// collected, so the fold from there is exact), at a candidate that does not
/// probe, or at `floor`.
pub(super) fn scan_fold_tail(
    file: &mut fs::File,
    end: u64,
    floor: u64,
    session_id: &str,
) -> io::Result<FoldTailScan> {
    let mut scan = FoldTailScan {
        records: Vec::new(),
        unreadable: false,
        bytes_read: 0,
        last_line: None,
    };
    let mut last_line = true;
    scan.bytes_read = scan_lines_backward(file, end, floor, |line, terminated| {
        let is_last = std::mem::replace(&mut last_line, false);
        let candidate = FOLD_TYPE_NEEDLES
            .iter()
            .any(|needle| needle.find(line).is_some());
        if !candidate && !is_last {
            return ControlFlow::Continue(());
        }
        let probe = probe_record(line, session_id);
        if is_last {
            scan.last_line = probe.as_ref().map(|probe| LastLine {
                seq: probe.seq,
                terminated,
            });
        }
        if !candidate {
            return ControlFlow::Continue(());
        }
        let Some(probe) = probe else {
            scan.unreadable = true;
            return ControlFlow::Break(());
        };
        let boundary = match probe.type_.as_str() {
            "user_prompt" | "agent_switch" => true,
            "prompt_complete" => false,
            _ => return ControlFlow::Continue(()),
        };
        scan.records.push(probe);
        if boundary {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    })?;
    Ok(scan)
}

static COMMANDS_UPDATE_NEEDLE: LazyLock<memmem::Finder<'static>> =
    LazyLock::new(|| memmem::Finder::new(b"\"type\":\"commands_update\""));

/// The `availableCommands` of the newest `commands_update` in `path`, the
/// value `materialize_session_payload` folds from a full replay. One backward
/// pass that parses only lines naming that type and stops at the first that
/// is one.
pub(super) fn newest_command_list(path: &Path, session_id: &str) -> io::Result<Option<Value>> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let end = file.metadata()?.len();
    let mut commands = None;
    scan_lines_backward(&mut file, end, 0, |line, terminated| {
        if !terminated || COMMANDS_UPDATE_NEEDLE.find(line).is_none() {
            return ControlFlow::Continue(());
        }
        match serde_json::from_slice::<PersistedEventRecord>(line) {
            Ok(record)
                if record.schema_version == SESSION_SCHEMA_VERSION
                    && record.session_id == session_id
                    && record.type_ == "commands_update" =>
            {
                commands = record.payload.get("availableCommands").cloned();
                ControlFlow::Break(())
            }
            _ => ControlFlow::Continue(()),
        }
    })?;
    Ok(commands)
}

pub(super) fn jsonl_first_record_is_valid(path: &Path, expected_session_id: &str) -> bool {
    use std::io::BufRead;
    let Ok(file) = fs::File::open(path) else {
        return true;
    };
    let mut reader = std::io::BufReader::new(file);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return true,
            Ok(_) => {}
        }
        if line.last() == Some(&b'\n') {
            line.pop();
        }
        if !line.is_empty() {
            return probe_record(&line, expected_session_id).is_some();
        }
    }
}

/// Backward-scan block for [`repair_jsonl_torn_tail`].
const REPAIR_SCAN_BLOCK: u64 = 64 * 1024;

/// Repair a torn final tail (incomplete write at the end of a JSONL file)
/// by scanning backward from the end of the file in bounded
/// [`REPAIR_SCAN_BLOCK`] blocks until the previous newline, then truncating
/// any unparseable trailing bytes. Only the final line is retained in memory
/// (never the full transcript, even when that last record is enormous), and
/// prevents later appends from landing after a torn line (which would make
/// `replay_after` return `CorruptSession`).
///
/// Returns `Some(seq)` when the tail was an intact record that merely lacked
/// its newline and was therefore preserved (so a live writer can advance its
/// sequence bookkeeping past it); `None` otherwise.
pub(super) fn repair_jsonl_torn_tail(path: &Path) -> Option<u64> {
    use std::io::{Read, Seek, SeekFrom, Write};

    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .ok()?; // missing file is handled by `ensure_log_exists`
    let file_size = file.metadata().ok()?.len();
    if file_size == 0 {
        return None;
    }
    // The common case, a log that already ends in `\n`, has no tail: one
    // byte decides it, with no block read.
    let mut last = [0u8; 1];
    file.seek(SeekFrom::End(-1)).ok()?;
    file.read_exact(&mut last).ok()?;
    if last[0] == b'\n' {
        return None;
    }
    // Walk back block by block until the newline that ends the previous
    // record. The retained chunks (newest first) are the tail only — the bytes
    // after that newline — so a >block-size last line costs its own length
    // and nothing more. A final record longer than any window is therefore
    // never mistaken for torn and truncated to zero.
    let mut chunks: Vec<Vec<u8>> = Vec::new();
    let mut pos = file_size;
    let valid_end = loop {
        let block_len = pos.min(REPAIR_SCAN_BLOCK);
        pos -= block_len;
        let mut buf = vec![0u8; block_len as usize];
        file.seek(SeekFrom::Start(pos)).ok()?;
        file.read_exact(&mut buf).ok()?;
        match buf.iter().rposition(|&b| b == b'\n') {
            Some(newline) => {
                chunks.push(buf.split_off(newline + 1));
                break pos + newline as u64 + 1;
            }
            None => {
                chunks.push(buf);
                if pos == 0 {
                    break 0; // no newline at all — the entire file is the tail
                }
            }
        }
    };
    let mut tail = Vec::with_capacity((file_size - valid_end) as usize);
    for chunk in chunks.iter().rev() {
        tail.extend_from_slice(chunk);
    }
    drop(chunks);
    // Empty tail: the file ends with a newline.
    if tail.is_empty() || tail.iter().all(|b| b.is_ascii_whitespace()) {
        return None;
    }
    // If the tail deserializes as a valid record it is only missing its
    // trailing newline (death between record and newline, or a failed newline
    // write): terminate it durably now. `append_record` refuses to write after
    // an unterminated tail, and leaving it would fuse the next record onto it.
    if let Ok(record) = serde_json::from_slice::<PersistedEventRecord>(&tail) {
        let terminated = file.seek(SeekFrom::End(0)).is_ok()
            && file.write_all(b"\n").is_ok()
            && file.sync_all().is_ok();
        if !terminated {
            // The record itself is intact, so it is left in place; appends
            // are refused until a later repair succeeds.
            log::warn!("[acp-history] could not terminate unterminated JSONL tail record");
        }
        return Some(record.seq);
    }
    // Torn tail — backup and truncate.
    let _ = atomic_file::backup_corrupt(path, &tail);
    let _ = file.set_len(valid_end);
    None
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
            if let Some(record) = probe_record(line, session_id) {
                max_seq = Some(max_seq.unwrap_or(0).max(record.seq));
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
    pub(super) fold: FoldCounts,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct LogStamps {
    messages: Option<FileStamp>,
    tool_calls: Option<FileStamp>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified: std::time::SystemTime,
}

pub(super) fn log_stamps(dir: &Path) -> io::Result<LogStamps> {
    let stamp = |name: &str| match fs::metadata(dir.join(name)) {
        Ok(metadata) => Ok(Some(FileStamp {
            len: metadata.len(),
            modified: metadata.modified()?,
        })),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    };
    Ok(LogStamps {
        messages: stamp(MESSAGES_FILE)?,
        tool_calls: stamp(TOOL_CALLS_FILE)?,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SalvageProbe {
    Clean,
    Intruders,
    Unsalvageable,
}

pub(super) fn probe_seq_intruders(dir: &Path, session_id: &str) -> Result<SalvageProbe> {
    let mut kept_seqs = std::collections::HashSet::new();
    let mut intruders = false;
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
            return Ok(SalvageProbe::Unsalvageable);
        };
        if !scan
            .kept_records
            .iter()
            .all(|record| kept_seqs.insert(record.seq))
        {
            return Ok(SalvageProbe::Unsalvageable);
        }
        intruders |= !scan.intruders.is_empty();
    }
    Ok(if intruders {
        SalvageProbe::Intruders
    } else {
        SalvageProbe::Clean
    })
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
    let mut intruder_lines = 0;
    // Kept records across BOTH files, collected then sorted by seq (the
    // fold's chunk-run rules depend on global seq order, not per-file order).
    let mut all_records: Vec<PersistedEventRecord> = Vec::new();
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
            all_records.push(record.clone());
        }
        if !salvageable {
            break;
        }
        intruder_lines += scan.intruder_lines;
        if !scan.intruders.is_empty() {
            staged.push((path, scan.kept, scan.intruders));
        }
    }
    if !salvageable || staged.is_empty() {
        return Ok(None);
    }
    let fold = fold_counts(&mut all_records);
    let counts = SalvageCounts {
        fold,
        last_seq: all_records.last().map_or(0, |record| record.seq),
        intruder_lines,
    };
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
