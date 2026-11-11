use super::oauth_redirect_base;

#[test]
fn redirect_base_is_loopback_on_the_bound_port() {
    for bind in ["0.0.0.0:8080", "127.0.0.1:8080", "192.168.1.5:8080"] {
        assert_eq!(
            oauth_redirect_base(bind.parse().unwrap()),
            "http://127.0.0.1:8080",
            "{bind}"
        );
    }
}
