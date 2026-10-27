use std::sync::OnceLock;

static TEST_NONCE: OnceLock<String> = OnceLock::new();

pub(crate) fn test_nonce() -> &'static str {
    TEST_NONCE.get_or_init(|| uuid::Uuid::new_v4().to_string())
}
