//! Newline-delimited reader for agent stdout with a hard per-line cap.
//!
//! `AsyncBufReadExt::lines` buffers a whole line before yielding it, so one
//! agent that never writes a newline makes Termul allocate without bound
//! (#1597). This reader stops buffering at [`MAX_AGENT_STDOUT_LINE_BYTES`]
//! and fails the stream instead of truncating: a cut JSON-RPC message would
//! only resurface later as a confusing parse error.

use futures::{AsyncBufRead, AsyncBufReadExt as _, Stream};

/// Largest agent stdout line, excluding its `\n` terminator, that is
/// accepted before the connection fails.
///
/// ACP sends one JSON-RPC message per line, and legitimate ones get large:
/// base64 image content blocks, whole-file reads, long tool output. The cap
/// sits far above those so it never rejects a real message; it exists only
/// to stop a misbehaving agent from exhausting memory.
pub(super) const MAX_AGENT_STDOUT_LINE_BYTES: usize = 64 * 1024 * 1024;

/// Split `reader` into lines like `AsyncBufReadExt::lines` (`\n` or `\r\n`
/// terminators, a final unterminated line is still yielded), but never buffer
/// more than `max_line_bytes` of one line. A longer line yields one
/// `InvalidData` error and ends the stream.
pub(super) fn bounded_lines<R>(
    reader: R,
    max_line_bytes: usize,
) -> impl Stream<Item = std::io::Result<String>> + Send
where
    R: AsyncBufRead + Unpin + Send,
{
    futures::stream::unfold(Some((reader, Vec::new())), move |state| async move {
        let (mut reader, mut line) = state?;
        match read_bounded_line(&mut reader, &mut line, max_line_bytes).await {
            Ok(true) => {
                let decoded = String::from_utf8(std::mem::take(&mut line))
                    .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error));
                Some((decoded, Some((reader, line))))
            }
            Ok(false) => None,
            // Dropping the reader ends the stream after the error.
            Err(error) => Some((Err(error), None)),
        }
    })
}

/// Read one line into `line` (cleared by the caller) without its terminator.
/// Returns `false` at EOF with nothing buffered.
async fn read_bounded_line<R>(
    reader: &mut R,
    line: &mut Vec<u8>,
    max_line_bytes: usize,
) -> std::io::Result<bool>
where
    R: AsyncBufRead + Unpin,
{
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(!line.is_empty());
        }
        let newline = available.iter().position(|&byte| byte == b'\n');
        let content = &available[..newline.unwrap_or(available.len())];
        if line.len() + content.len() > max_line_bytes {
            log::warn!(
                "[acp] agent stdout line exceeded the {max_line_bytes}-byte limit; closing the agent connection"
            );
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("agent stdout line exceeded the {max_line_bytes}-byte limit"),
            ));
        }
        line.extend_from_slice(content);
        let consumed = newline.map_or(content.len(), |index| index + 1);
        reader.consume_unpin(consumed);
        if newline.is_some() {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(true);
        }
    }
}
