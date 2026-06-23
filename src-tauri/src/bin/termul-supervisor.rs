#[cfg(unix)]
fn main() {
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use termul_manager_lib::session_recovery::{daemon, server};

    // Detach from the parent process group so the daemon (and its PTY children)
    // survive a force-closed / crashed Termul.
    daemon::daemonize_detach();

    let socket_path = server::default_socket_path();
    let table = Arc::new(daemon::SessionTable::new());
    let shutdown = Arc::new(AtomicBool::new(false));

    eprintln!(
        "termul-supervisor protocol={} pid={} socket={}",
        termul_manager_lib::session_recovery::ipc::SUPERVISOR_PROTOCOL_VERSION,
        std::process::id(),
        socket_path.display()
    );

    if let Err(e) = server::serve(&socket_path, table, shutdown) {
        eprintln!("termul-supervisor server error: {e}");
        std::process::exit(1);
    }
}

#[cfg(not(unix))]
fn main() {
    // Windows named-pipe transport + ConPTY ownership is a separate platform
    // and is not implemented yet.
    eprintln!(
        "termul-supervisor protocol={} (no daemon transport on this platform yet)",
        termul_manager_lib::session_recovery::ipc::SUPERVISOR_PROTOCOL_VERSION
    );
}
