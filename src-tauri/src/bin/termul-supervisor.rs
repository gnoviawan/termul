fn main() {
    println!(
        "termul-supervisor protocol={}",
        termul_manager_lib::session_recovery::ipc::SUPERVISOR_PROTOCOL_VERSION
    );
}
