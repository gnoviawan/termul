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
    if let Err(e) = delete_password(profile_id) {
        log::warn!("[SSH] {}", e);
    }

    if let Err(e) = delete_passphrase(profile_id) {
        log::warn!("[SSH] {}", e);
    }

    Ok(())
}
