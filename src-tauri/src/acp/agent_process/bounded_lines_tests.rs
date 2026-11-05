//! Tests for the bounded agent stdout line reader (#1597). The cap is passed
//! in, so these run with a few bytes instead of the 64 MiB production limit.

use futures::io::{BufReader, Cursor};
use futures::StreamExt as _;

use super::bounded_lines::{bounded_lines, MAX_AGENT_STDOUT_LINE_BYTES};

/// Collect every item; `capacity` is the `BufReader` size, kept tiny so lines
/// span several buffer fills.
fn collect(input: &[u8], capacity: usize, max_line_bytes: usize) -> Vec<std::io::Result<String>> {
    let reader = BufReader::with_capacity(capacity, Cursor::new(input.to_vec()));
    futures::executor::block_on(bounded_lines(reader, max_line_bytes).collect())
}

fn ok_lines(items: Vec<std::io::Result<String>>) -> Vec<String> {
    items
        .into_iter()
        .map(|item| item.expect("line should be read"))
        .collect()
}

#[test]
fn lines_under_the_cap_pass_like_async_lines() {
    let items = collect(b"{\"a\":1}\r\n\n{\"b\":2}\nlast", 3, 16);
    assert_eq!(ok_lines(items), ["{\"a\":1}", "", "{\"b\":2}", "last"]);
}

#[test]
fn empty_input_ends_without_items() {
    assert!(collect(b"", 8, 16).is_empty());
}

#[test]
fn a_line_exactly_at_the_cap_passes() {
    let items = collect(b"abcd\nefgh", 2, 4);
    assert_eq!(ok_lines(items), ["abcd", "efgh"]);
}

#[test]
fn a_line_over_the_cap_errors_and_ends_the_stream() {
    let items = collect(b"ok\nabcdefgh\nnever read\n", 3, 4);
    assert_eq!(items.len(), 2, "the stream must end after the error");
    assert_eq!(items[0].as_ref().unwrap(), "ok");
    let error = items[1].as_ref().unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert!(error.to_string().contains("4-byte limit"), "{error}");
}

#[test]
fn an_unterminated_line_over_the_cap_errors() {
    let items = collect(b"abcdefgh", 8, 4);
    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0].as_ref().unwrap_err().kind(),
        std::io::ErrorKind::InvalidData
    );
}

#[test]
fn invalid_utf8_is_an_error() {
    let items = collect(b"\xff\xfe\n", 8, 16);
    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0].as_ref().unwrap_err().kind(),
        std::io::ErrorKind::InvalidData
    );
}

#[test]
fn production_cap_leaves_room_for_large_messages() {
    assert_eq!(MAX_AGENT_STDOUT_LINE_BYTES, 64 * 1024 * 1024);
}
