use parking_lot::RwLock;
use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use lazy_static::lazy_static;

// OSC 133;D;{exit_code} escape sequence pattern (shell integration protocol)
lazy_static! {
    static ref OSC_EXIT_CODE_RE: Regex =
        Regex::new(r"\x1b\]133;D;?(\d*)\x07").unwrap();
}

// Simple marker pattern as fallback (injected via PROMPT_COMMAND)
lazy_static! {
    static ref EXIT_MARKER_RE: Regex = Regex::new(r"__TERMUL_EXIT__(\d+)__").unwrap();
}

/// Quick check strings for performance optimization
const OSC_QUICK_CHECK: &str = "\x1b]133;D";
const MARKER_QUICK_CHECK: &str = "__TERMUL_EXIT__";

/// State for tracking a terminal's exit code
#[derive(Debug, Clone)]
struct ExitCodeState {
    _terminal_id: String,
    last_exit_code: Option<i32>,
}

/// Event emitted when exit code changes
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitCodeChangedEvent {
    pub terminal_id: String,
    pub exit_code: i32,
}

/// Tracks exit codes from terminal output
pub struct ExitCodeTracker {
    terminal_states: Arc<RwLock<HashMap<String, ExitCodeState>>>,
    app_handle: AppHandle,
}

impl ExitCodeTracker {
    /// Create a new ExitCodeTracker
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            terminal_states: Arc::new(RwLock::new(HashMap::new())),
            app_handle,
        }
    }

    /// Parse exit code from data string
    ///
    /// Returns Some(exit_code) if found, None otherwise.
    /// Uses quick string checks before regex for performance.
    pub fn parse_exit_code(data: &str) -> Option<i32> {
        // Quick check: if neither pattern exists, return None immediately
        if !data.contains(OSC_QUICK_CHECK) && !data.contains(MARKER_QUICK_CHECK) {
            return None;
        }

        // Try OSC 133;D pattern first (preferred method)
        if let Some(captures) = OSC_EXIT_CODE_RE.captures(data) {
            let code_str = captures.get(1).map(|m| m.as_str()).unwrap_or("");
            // If no exit code in sequence, assume 0
            return Some(if code_str.is_empty() {
                0
            } else {
                code_str.parse().unwrap_or(0)
            });
        }

        // Try custom marker pattern as fallback
        if let Some(captures) = EXIT_MARKER_RE.captures(data) {
            if let Some(code_str) = captures.get(1) {
                return code_str.as_str().parse().ok();
            }
        }

        None
    }

    /// Process terminal data and check for exit codes
    ///
    /// Called by PtyManager when new data is received from the PTY.
    /// Emits "terminal-exit-code-changed" event if exit code changes.
    pub fn process_data(&self, terminal_id: &str, data: &str) {
        let exit_code = Self::parse_exit_code(data);
        if let Some(code) = exit_code {
            let mut states = self.terminal_states.write();

            if let Some(state) = states.get_mut(terminal_id) {
                // Only emit if the exit code has changed
                if state.last_exit_code != Some(code) {
                    state.last_exit_code = Some(code);

                    // Emit the event (drop lock first)
                    let term_id = terminal_id.to_string();
                    drop(states);
                    self.emit_exit_code_changed(&term_id, code);
                }
            }
        }
    }

    /// Initialize tracking for a terminal
    ///
    /// Called when a new terminal is created.
    pub fn initialize_terminal(&self, terminal_id: &str) {
        let state = ExitCodeState {
            _terminal_id: terminal_id.to_string(),
            last_exit_code: None,
        };
        self.terminal_states
            .write()
            .insert(terminal_id.to_string(), state);
    }

    /// Remove a terminal from tracking
    ///
    /// Called when a terminal is destroyed.
    pub fn remove_terminal(&self, terminal_id: &str) {
        self.terminal_states.write().remove(terminal_id);
    }

    /// Get the last known exit code for a terminal
    pub fn get_exit_code(&self, terminal_id: &str) -> Option<i32> {
        self.terminal_states
            .read()
            .get(terminal_id)
            .and_then(|s| s.last_exit_code)
    }

    /// Emit exit code changed event
    fn emit_exit_code_changed(&self, terminal_id: &str, exit_code: i32) {
        let event = ExitCodeChangedEvent {
            terminal_id: terminal_id.to_string(),
            exit_code,
        };
        let _ = self
            .app_handle
            .emit("terminal-exit-code-changed", event);
    }

    /// Shutdown the tracker
    ///
    /// Clears all tracked terminal states.
    pub fn shutdown(&self) {
        self.terminal_states.write().clear();
    }
}

impl Clone for ExitCodeTracker {
    fn clone(&self) -> Self {
        Self {
            terminal_states: self.terminal_states.clone(),
            app_handle: self.app_handle.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
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
}
