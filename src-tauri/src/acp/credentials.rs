//! Shared OS-keychain plumbing for ACP agent credentials (Factory key, Claude
//! auth state). Every helper opens the service's keyring entry, rejects the
//! non-persisting mock backend, and verifies writes by reading back.
//!
//! NEVER log key material — callers log counts/mode names/generic errors only.

use keyring::Entry;

/// One keyring service for all Termul agent credentials.
pub(crate) const KEYRING_SERVICE: &str = "com.termul.manager";

/// Open a keyring entry for `account`, rejecting keyring's mock fallback
/// backend (it accepts writes but never persists them — success would be a
/// lie). Fails closed with the caller-facing generic message.
pub(crate) fn open_entry(account: &str) -> Result<Entry, String> {
    let entry = Entry::new(KEYRING_SERVICE, account)
        .map_err(|_| "OS keychain unavailable".to_string())?;
    // keyring's fallback backend accepts writes but never persists them.
    if entry.get_credential().is::<keyring::mock::MockCredential>() {
        return Err("OS keychain unavailable".to_string());
    }
    Ok(entry)
}

/// Read a secret. `Ok(None)` when absent; `Err(empty_message)` when the stored
/// value is empty (a corrupt state no caller should treat as "configured");
/// `Err("OS keychain unavailable")` for any backend failure.
pub(crate) fn read_secret(account: &str, empty_message: &str) -> Result<Option<String>, String> {
    match open_entry(account)?.get_password() {
        Ok(value) if !value.is_empty() => Ok(Some(value)),
        Ok(_) => Err(empty_message.to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("OS keychain unavailable".to_string()),
    }
}

/// Write a secret and verify by reading the entry back. No success on a
/// write-only/locked backend; never falls back to an in-process copy.
pub(crate) fn write_secret(
    account: &str,
    value: &str,
    save_message: &str,
    verify_message: &str,
) -> Result<(), String> {
    open_entry(account)?
        .set_password(value)
        .map_err(|_| save_message.to_string())?;
    if read_secret(account, verify_message)?.as_deref() != Some(value) {
        return Err(verify_message.to_string());
    }
    Ok(())
}

/// Delete a secret. Deleting an absent entry is already the desired end state,
/// so `NoEntry` succeeds (idempotent delete).
pub(crate) fn delete_secret(account: &str, delete_message: &str) -> Result<(), String> {
    match open_entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(delete_message.to_string()),
    }
}
