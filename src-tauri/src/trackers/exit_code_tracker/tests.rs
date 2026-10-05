use super::*;

// Note: Full integration tests with AppHandle would require Tauri test utilities
// These tests focus on the core parsing logic

#[test]
fn test_parse_exit_code_osc_133() {
    let code = ExitCodeTracker::parse_exit_code("\x1b]133;D;0\x07");
    assert_eq!(code, Some(0));
}

#[test]
fn test_parse_exit_code_osc_133_with_code() {
    let code = ExitCodeTracker::parse_exit_code("\x1b]133;D;1\x07");
    assert_eq!(code, Some(1));
}

#[test]
fn test_parse_exit_code_osc_133_empty() {
    let code = ExitCodeTracker::parse_exit_code("\x1b]133;D;\x07");
    assert_eq!(code, Some(0)); // Default to 0
}

#[test]
fn test_parse_exit_code_marker() {
    let code = ExitCodeTracker::parse_exit_code("__TERMUL_EXIT__127__");
    assert_eq!(code, Some(127));
}

#[test]
fn test_parse_exit_code_no_match() {
    let code = ExitCodeTracker::parse_exit_code("normal output");
    assert_eq!(code, None);
}

#[test]
fn test_parse_exit_code_mixed() {
    let code = ExitCodeTracker::parse_exit_code("prompt \x1b]133;D;0\x07 $ ");
    assert_eq!(code, Some(0));
}

#[test]
fn test_parse_exit_code_quick_check_performance() {
    // Large string without any exit code patterns
    let data = "a".repeat(10000);
    assert_eq!(ExitCodeTracker::parse_exit_code(&data), None);
}

#[test]
fn test_parse_exit_code_osc_preferred_over_marker() {
    // OSC should be tried first and returned
    let data = "\x1b]133;D;7\x07 and __TERMUL_EXIT__99__";
    assert_eq!(ExitCodeTracker::parse_exit_code(data), Some(7));
}

#[test]
fn test_parse_exit_code_multiple_osc_sequences() {
    let data = "\x1b]133;D;1\x07\x1b]133;D;2\x07";
    assert_eq!(ExitCodeTracker::parse_exit_code(data), Some(1));
}

#[test]
fn test_parse_exit_code_multiple_markers() {
    let data = "__TERMUL_EXIT__10____TERMUL_EXIT__20__";
    assert_eq!(ExitCodeTracker::parse_exit_code(data), Some(10));
}

#[test]
fn test_parse_exit_code_invalid_marker() {
    let code = ExitCodeTracker::parse_exit_code("__TERMUL_EXIT__abc__");
    assert_eq!(code, None);
}

#[test]
fn test_parse_exit_code_osc_with_non_digits() {
    // When OSC pattern has non-digits after D; (not captured by \d*), pattern doesn't match
    let code = ExitCodeTracker::parse_exit_code("\x1b]133;D;abc\x07");
    assert_eq!(code, None); // Pattern requires digits (\d*), so "abc" won't match
}
