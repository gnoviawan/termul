use super::*;
use std::ops::ControlFlow;

fn temp_file(label: &str, bytes: &[u8]) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "termul-jsonl-{label}-{}-{}",
        std::process::id(),
        now_millis()
    ));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("lines.jsonl");
    fs::write(&path, bytes).unwrap();
    (dir, path)
}

/// Every visited line, last first, as (bytes, newline-terminated).
fn visit_all(path: &Path, floor: u64) -> (Vec<(Vec<u8>, bool)>, u64) {
    let mut file = fs::File::open(path).unwrap();
    let end = file.metadata().unwrap().len();
    let mut lines = Vec::new();
    let read = scan_lines_backward(&mut file, end, floor, |line, terminated| {
        lines.push((line.to_vec(), terminated));
        ControlFlow::Continue(())
    })
    .unwrap();
    (lines, read)
}

/// Line lengths around the reader's 16 KiB first read and its doubling reads,
/// plus one longer than the 1 MiB read cap.
const SIZES: [usize; 8] = [
    1,
    16 * 1024 - 1,
    16 * 1024,
    16 * 1024 + 1,
    40_000,
    3 * 1024 * 1024 / 2,
    70_000,
    5,
];

/// Each line's bytes are distinct per index, so a mis-joined carry shows.
fn line_bytes(index: usize, len: usize) -> Vec<u8> {
    (0..len).map(|i| b'a' + ((index * 7 + i) % 26) as u8).collect()
}

/// Every line comes back byte-exact, last first, whatever its length relative
/// to the reader's growing reads; blank lines are skipped; only a bare final
/// line is reported unterminated; and the whole file is read exactly once.
#[test]
fn backward_reader_returns_every_line_exactly_once() {
    let mut bytes = Vec::new();
    let mut expected = Vec::new();
    for (index, len) in SIZES.into_iter().enumerate() {
        let line = line_bytes(index, len);
        bytes.extend_from_slice(&line);
        let last = index + 1 == SIZES.len();
        if !last {
            bytes.push(b'\n');
        }
        if index == 1 {
            bytes.extend_from_slice(b"\n\n");
        }
        expected.push((line, !last));
    }
    expected.reverse();
    let (dir, path) = temp_file("exact", &bytes);

    let (lines, read) = visit_all(&path, 0);
    assert_eq!(lines.len(), expected.len());
    for (got, want) in lines.iter().zip(&expected) {
        assert_eq!(got.1, want.1);
        assert!(got.0 == want.0, "line of {} bytes mis-read", want.0.len());
    }
    assert_eq!(read, bytes.len() as u64);
    let _ = fs::remove_dir_all(dir);
}

/// A pass bounded by a line-start `floor` visits only the lines at or after
/// it and reads no byte before it; `floor == end` visits nothing.
#[test]
fn backward_reader_stops_at_a_line_start_floor() {
    let mut bytes = Vec::new();
    let mut starts = Vec::new();
    for (index, len) in SIZES.into_iter().enumerate() {
        starts.push(bytes.len() as u64);
        bytes.extend_from_slice(&line_bytes(index, len));
        bytes.push(b'\n');
    }
    let (dir, path) = temp_file("floor", &bytes);

    let floor = starts[4];
    let (lines, read) = visit_all(&path, floor);
    let want: Vec<Vec<u8>> = (4..SIZES.len())
        .rev()
        .map(|index| line_bytes(index, SIZES[index]))
        .collect();
    let got: Vec<Vec<u8>> = lines.into_iter().map(|(line, _)| line).collect();
    assert!(got == want, "lines past the floor mis-read");
    assert_eq!(read, bytes.len() as u64 - floor);

    let (lines, read) = visit_all(&path, bytes.len() as u64);
    assert!(lines.is_empty());
    assert_eq!(read, 0);
    let _ = fs::remove_dir_all(dir);
}

fn record_line(session_id: &str) -> Vec<u8> {
    let mut line = serde_json::to_vec(&PersistedEventRecord {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id: session_id.to_string(),
        seq: 1,
        type_: "user_prompt".to_string(),
        recorded_at: 1,
        payload: serde_json::json!({}),
    })
    .unwrap();
    line.push(b'\n');
    line
}

#[test]
fn first_record_probe_agrees_with_load_jsonl() {
    let record = record_line("s");
    let cases: [(&str, Vec<u8>, bool); 6] = [
        ("empty-file", Vec::new(), true),
        ("record", record.clone(), true),
        (
            "blank-then-record",
            [b"\n".as_slice(), &record].concat(),
            true,
        ),
        ("spaces", [b"   \n".as_slice(), &record].concat(), false),
        (
            "carriage-return",
            [b"\r\n".as_slice(), &record].concat(),
            false,
        ),
        ("blank-then-garbage", b"\nnot a record\n".to_vec(), false),
    ];
    for (label, bytes, valid) in cases {
        let (dir, path) = temp_file(label, &bytes);
        assert_eq!(jsonl_first_record_is_valid(&path, "s"), valid, "{label}");
        assert_eq!(load_jsonl(&path, "s", false).is_ok(), valid, "{label}");
        let _ = fs::remove_dir_all(dir);
    }
}
