use super::owned_ports::{is_owned, OwnedPort};

// Ports in the dynamic range that no other test claims.
const PORT_A: u16 = 61_901;
const PORT_B: u16 = 61_902;

#[test]
fn claimed_port_is_owned_until_the_guard_drops() {
    assert!(!is_owned(PORT_A));
    let guard = OwnedPort::claim(PORT_A);
    assert!(is_owned(PORT_A));
    drop(guard);
    assert!(!is_owned(PORT_A));
}

#[test]
fn port_stays_owned_while_any_claim_is_live() {
    let first = OwnedPort::claim(PORT_B);
    let second = OwnedPort::claim(PORT_B);
    drop(first);
    assert!(is_owned(PORT_B));
    drop(second);
    assert!(!is_owned(PORT_B));
}

#[test]
fn port_zero_is_never_owned() {
    let _guard = OwnedPort::claim(0);
    assert!(!is_owned(0));
}
