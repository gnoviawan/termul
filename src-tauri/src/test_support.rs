use std::sync::OnceLock;

static TEST_NONCE: OnceLock<String> = OnceLock::new();
static INVALID_TEST_NONCE: OnceLock<String> = OnceLock::new();

pub(crate) fn test_nonce() -> &'static str {
    TEST_NONCE.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

pub(crate) fn invalid_test_nonce() -> &'static str {
    INVALID_TEST_NONCE.get_or_init(|| loop {
        let nonce = uuid::Uuid::new_v4().to_string();
        if nonce != test_nonce() {
            break nonce;
        }
    })
}
