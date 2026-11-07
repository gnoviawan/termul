//! Termul session protocol shared by the host filter and both clients.
//!
//! The ident is private. It is not an ambient shell-integration OSC.

/// OSC ident for Termul session frames. Not 133, 633, or 9278.
pub const TERMUL_SESSION_OSC: u16 = 9477;

/// Clears the shell line editor. No command text.
pub const CLEAR_LINE_SEQUENCE: &str = "\u{1b}[99;1~";

/// Restores the shell prompt. Distinct from the clear-line sequence.
pub const RESTORE_PROMPT_SEQUENCE: &str = "\u{1b}[99;2~";

mod bracketed_paste;
mod completion;
pub mod deliver;
pub mod filter;
pub mod frame;
pub mod gate;
pub mod prompt_spacer;
pub mod rpc;
pub mod suppression;

#[cfg(test)]
mod bracketed_paste_tests;
#[cfg(test)]
mod filter_limit_tests;
#[cfg(test)]
mod filter_tests;
#[cfg(test)]
mod gate_test_support;
#[cfg(test)]
mod gate_tests;
#[cfg(test)]
mod isolation_tests;
#[cfg(test)]
mod prompt_spacer_tests;
#[cfg(test)]
mod tests;
