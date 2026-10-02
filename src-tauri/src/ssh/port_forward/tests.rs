use super::*;

#[test]
fn write_all_nonblocking_retries_after_would_block() {
    struct FlakyWriter {
        attempts: usize,
        output: Vec<u8>,
    }

    impl Write for FlakyWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.attempts += 1;
            if self.attempts == 1 {
                return Err(std::io::Error::from(std::io::ErrorKind::WouldBlock));
            }
            self.output.extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let mut writer = FlakyWriter {
        attempts: 0,
        output: Vec::new(),
    };

    write_all_nonblocking(&mut writer, b"hello").expect("write should retry and succeed");

    assert_eq!(writer.output, b"hello");
}

#[tokio::test]
async fn stop_all_in_map_signals_and_clears() {
    let should_stop = Arc::new(AtomicBool::new(false));
    let should_stop_assertion = should_stop.clone();
    let task = tokio::spawn(async {});
    let forward = ActivePortForward {
        id: "forward-1".to_string(),
        config_id: "forward-1".to_string(),
        local_port: 8080,
        remote_host: "127.0.0.1".to_string(),
        remote_port: 80,
        forward_type: "local".to_string(),
        status: "active".to_string(),
        error: None,
    };

    let mut forwards = HashMap::from([(
        "conn-1".to_string(),
        HashMap::from([(
            "forward-1".to_string(),
            ForwardHandle {
                should_stop,
                task,
                info: forward,
            },
        )]),
    )]);

    // Drain and signal stop (same logic as stop_all without emit)
    for (_, conn_forwards) in forwards.drain() {
        for (_, handle) in conn_forwards {
            handle.should_stop.store(true, Ordering::Relaxed);
            handle.task.abort();
        }
    }

    assert!(forwards.is_empty());
    assert!(should_stop_assertion.load(Ordering::Relaxed));
}
