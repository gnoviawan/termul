use keyring::Entry;
use serde::{Deserialize, Serialize};

const SERVICE_NAME: &str = "com.termul.manager";

#[derive(Debug, Serialize, Deserialize)]
pub struct SecureStorageRequest {
    pub key: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SecureStorageSetRequest {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SecureStorageResponse<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl<T> SecureStorageResponse<T> {
    pub fn success(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
            code: None,
        }
    }

    pub fn error(error: String, code: String) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(error),
            code: Some(code),
        }
    }
}

impl SecureStorageResponse<()> {
    pub fn success_void() -> Self {
        Self {
            success: true,
            data: None,
            error: None,
            code: None,
        }
    }
}

fn get_entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE_NAME, key).map_err(|e| format!("Failed to create keyring entry: {}", e))
}

#[tauri::command]
pub fn secure_storage_set(request: SecureStorageSetRequest) -> SecureStorageResponse<()> {
    match get_entry(&request.key) {
        Ok(entry) => match entry.set_password(&request.value) {
            Ok(_) => SecureStorageResponse::success_void(),
            Err(e) => SecureStorageResponse::error(
                format!("Failed to store secret: {}", e),
                "STORAGE_ERROR".to_string(),
            ),
        },
        Err(e) => SecureStorageResponse::error(e, "KEYRING_ERROR".to_string()),
    }
}

#[tauri::command]
pub fn secure_storage_get(request: SecureStorageRequest) -> SecureStorageResponse<String> {
    match get_entry(&request.key) {
        Ok(entry) => match entry.get_password() {
            Ok(value) => SecureStorageResponse::success(value),
            Err(keyring::Error::NoEntry) => SecureStorageResponse::error(
                format!("Secret not found for key: {}", request.key),
                "KEY_NOT_FOUND".to_string(),
            ),
            Err(e) => SecureStorageResponse::error(
                format!("Failed to retrieve secret: {}", e),
                "RETRIEVAL_ERROR".to_string(),
            ),
        },
        Err(e) => SecureStorageResponse::error(e, "KEYRING_ERROR".to_string()),
    }
}

#[tauri::command]
pub fn secure_storage_delete(request: SecureStorageRequest) -> SecureStorageResponse<()> {
    match get_entry(&request.key) {
        Ok(entry) => match entry.delete_credential() {
            Ok(_) => SecureStorageResponse::success_void(),
            Err(keyring::Error::NoEntry) => {
                // Deleting a non-existent key is considered success
                SecureStorageResponse::success_void()
            }
            Err(e) => SecureStorageResponse::error(
                format!("Failed to delete secret: {}", e),
                "DELETE_ERROR".to_string(),
            ),
        },
        Err(e) => SecureStorageResponse::error(e, "KEYRING_ERROR".to_string()),
    }
}
