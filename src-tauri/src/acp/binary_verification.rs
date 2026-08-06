use std::{
    fs::File,
    io::{BufReader, Read},
    path::Path,
};

use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryVerification {
    pub expected_sha256: String,
    pub actual_sha256: String,
    pub matches: bool,
    pub size: u64,
}

pub fn verify(path: &str, expected_sha256: &str) -> Result<BinaryVerification, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("binary path must not be empty".to_string());
    }

    let expected_sha256 = expected_sha256.trim().to_ascii_lowercase();
    if expected_sha256.len() != 64 || !expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("expected sha-256 must contain 64 hexadecimal characters".to_string());
    }

    let file = File::open(path).map_err(|error| format!("could not open binary: {error}"))?;
    let size = file
        .metadata()
        .map_err(|error| format!("could not inspect binary: {error}"))?
        .len();
    let mut reader = BufReader::with_capacity(1024 * 1024, file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];

    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("could not read binary: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    let digest = hasher.finalize();
    let actual_sha256 = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    Ok(BinaryVerification {
        matches: actual_sha256 == expected_sha256,
        expected_sha256,
        actual_sha256,
        size,
    })
}

pub fn display_name(path: &str) -> &str {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("<unknown>")
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::verify;

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "termul-acp-binary-verification-{}-{name}",
            std::process::id(),
        ))
    }

    #[test]
    fn verifies_sha256_and_size() {
        let path = test_path("match");
        fs::write(&path, b"hello").expect("write test binary");

        let result = verify(
            path.to_str().expect("utf-8 test path"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        )
        .expect("verify test binary");

        assert!(result.matches);
        assert_eq!(result.size, 5);
        assert_eq!(result.actual_sha256, result.expected_sha256);
        fs::remove_file(path).expect("remove test binary");
    }

    #[test]
    fn reports_a_checksum_mismatch() {
        let path = test_path("mismatch");
        fs::write(&path, b"hello").expect("write test binary");

        let result = verify(
            path.to_str().expect("utf-8 test path"),
            "0000000000000000000000000000000000000000000000000000000000000000",
        )
        .expect("verify test binary");

        assert!(!result.matches);
        fs::remove_file(path).expect("remove test binary");
    }

    #[test]
    fn rejects_invalid_expected_hashes() {
        let error = verify("/tmp/not-used", "not-a-hash").expect_err("invalid hash must fail");
        assert!(error.contains("64 hexadecimal"));
    }
}
