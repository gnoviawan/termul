//! Host-held trust: today only the AD-7 launch digest. Story 8 adds the
//! `McpTrustStore` (entries, secrets, approvals) next to it and reuses
//! [`launch_digest`] unchanged.

pub mod digest;

#[cfg(test)]
mod digest_tests;

pub use digest::launch_digest;
