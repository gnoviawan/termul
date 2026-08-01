//! Secure Credential Store
//!
//! Uses the OS keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service)
//! to store and retrieve SSH passwords and passphrases instead of persisting them in plain text.

use keyring::Entry;

const SERVICE_NAME: &str = "termul-ssh";

/// Key suffix for password credentials
const PASSWORD_SUFFIX: &str = "password";
/// Key suffix for passphrase credentials
const PASSPHRASE_SUFFIX: &str = "passphrase";

/// Store a password for the given profile ID in the OS keychain.
pub fn store_password(profile_id: &str, password: &str) -> Result<(), String> {
    let key = format!("{}-{}", profile_id, PASSWORD_SUFFIX);
    let entry = Entry::new(SERVICE_NAME, &key)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
    entry
        .set_password(password)
        .map_err(|e| format!("Failed to store password in keychain: {}", e))
}

/// Retrieve a stored password for the given profile ID from the OS keychain.
pub fn get_password(profile_id: &str) -> Result<Option<String>, String> {
    let key = format!("{}-{}", profile_id, PASSWORD_SUFFIX);
    let entry = Entry::new(SERVICE_NAME, &key)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to retrieve password from keychain: {}", e)),
    }
}

/// Store a passphrase for the given profile ID in the OS keychain.
pub fn store_passphrase(profile_id: &str, passphrase: &str) -> Result<(), String> {
    let key = format!("{}-{}", profile_id, PASSPHRASE_SUFFIX);
    let entry = Entry::new(SERVICE_NAME, &key)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
    entry
        .set_password(passphrase)
        .map_err(|e| format!("Failed to store passphrase in keychain: {}", e))
}

/// Retrieve a stored passphrase for the given profile ID from the OS keychain.
pub fn get_passphrase(profile_id: &str) -> Result<Option<String>, String> {
    let key = format!("{}-{}", profile_id, PASSPHRASE_SUFFIX);
    let entry = Entry::new(SERVICE_NAME, &key)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
    match entry.get_password() {
        Ok(passphrase) => Ok(Some(passphrase)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!(
            "Failed to retrieve passphrase from keychain: {}",
            e
        )),
    }
}

fn delete_key(profile_id: &str, suffix: &str, label: &str) -> Result<(), String> {
    let key = format!("{}-{}", profile_id, suffix);
    let entry = Entry::new(SERVICE_NAME, &key)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;

    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to delete {} from keychain: {}", label, e)),
    }
}

/// Delete the stored password for a profile.
pub fn delete_password(profile_id: &str) -> Result<(), String> {
    delete_key(profile_id, PASSWORD_SUFFIX, "password")
}

/// Delete the stored key passphrase for a profile.
pub fn delete_passphrase(profile_id: &str) -> Result<(), String> {
    delete_key(profile_id, PASSPHRASE_SUFFIX, "passphrase")
}

/// Delete all stored credentials for a profile (both password and passphrase).
pub fn delete_credentials(profile_id: &str) -> Result<(), String> {
    let mut errors = Vec::new();

    if let Err(e) = delete_password(profile_id) {
        errors.push(format!("password: {}", e));
    }

    if let Err(e) = delete_passphrase(profile_id) {
        errors.push(format!("passphrase: {}", e));
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("Failed to delete credentials: {}", errors.join("; ")))
    }
}

/// Verify that the configured keyring backend actually persists secrets.
///
/// `keyring` selects its backend at compile time; without an OS-backend cargo
/// feature it silently uses an in-memory mock where `set_password` succeeds but
/// `get_password` returns `NoEntry`. This round-trips a throwaway entry and
/// returns an error if the store is non-functional, so misconfiguration is
/// caught at startup instead of silently losing every credential.
pub fn self_test() -> Result<(), String> {
    let key = format!("__selftest-{}", uuid::Uuid::new_v4());
    let probe = "ok";
    let entry = Entry::new(SERVICE_NAME, &key)
        .map_err(|e| format!("keyring unavailable: {}", e))?;
    entry
        .set_password(probe)
        .map_err(|e| format!("keyring write failed: {}", e))?;
    let read_back = match entry.get_password() {
        Ok(v) => v,
        Err(e) => {
            if let Err(del_err) = entry.delete_credential() {
                return Err(format!(
                    "keyring read-back failed ({}) and probe cleanup also failed: {}",
                    e, del_err
                ));
            }
            return Err(format!(
                "keyring read-back failed (likely no OS backend compiled in): {}",
                e
            ));
        }
    };
    // Clean up the probe; a cleanup failure indicates a partially-working
    // backend and is itself worth surfacing.
    let delete_result = entry.delete_credential();
    if read_back != probe {
        return Err("keyring read-back mismatch (mock/in-memory store active)".to_string());
    }
    if let Err(del_err) = delete_result {
        return Err(format!("keyring probe cleanup failed: {}", del_err));
    }
    Ok(())
}
