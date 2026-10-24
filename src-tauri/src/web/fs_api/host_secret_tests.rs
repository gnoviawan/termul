use super::tests::{body_as_json, get_request, post_json, test_state, urlencoding, TempDir};
use super::*;
use crate::web::host_local::HOST_LOCAL_TOKEN_FILE;

const CREDENTIAL: &str = "host-local-credential-value";

/// A protected state dir holding the host-local credential, a Claude Account
/// directory, and one ordinary file.
fn state_dir(label: &str) -> TempDir {
    let dir = TempDir::new(label);
    fs::write(dir.path().join(HOST_LOCAL_TOKEN_FILE), CREDENTIAL).unwrap();
    fs::write(
        dir.path().join(crate::web::auth::WEB_AUTH_TOKEN_FILE),
        "bearer",
    )
    .unwrap();
    fs::create_dir_all(dir.path().join("claude-accounts/a1")).unwrap();
    fs::write(
        dir.path().join("claude-accounts/a1/.credentials.json"),
        "{}",
    )
    .unwrap();
    fs::write(dir.path().join("notes.txt"), "ordinary").unwrap();
    crate::web::host_secrets::protect_state_dir(dir.path());
    dir
}

fn query(route: &str, path: &Path) -> String {
    format!("{route}?path={}", urlencoding(&path.to_string_lossy()))
}

async fn get_code(uri: &str) -> Option<String> {
    let resp = get_request(test_state(), uri).await;
    let body: IpcBody<serde_json::Value> = body_as_json(resp.into_body()).await;
    body.code
}

async fn post_code(uri: &str, body: serde_json::Value) -> Option<String> {
    let resp = post_json(test_state(), uri, &body).await;
    let body: IpcBody<serde_json::Value> = body_as_json(resp.into_body()).await;
    body.code
}

fn forbidden() -> Option<String> {
    Some("FORBIDDEN".to_string())
}

#[tokio::test]
async fn read_refuses_the_credentials_and_serves_their_neighbours() {
    let dir = state_dir("secret-read");
    let token = dir.path().join(HOST_LOCAL_TOKEN_FILE);
    let resp = get_request(test_state(), &query("/fs/read", &token)).await;
    let body: IpcBody<FileContentDto> = body_as_json(resp.into_body()).await;
    assert_eq!(body.code, forbidden());
    assert!(body.data.is_none());
    assert!(!body.error.unwrap().contains(CREDENTIAL));

    let bearer = dir.path().join(crate::web::auth::WEB_AUTH_TOKEN_FILE);
    assert_eq!(get_code(&query("/fs/read", &bearer)).await, forbidden());
    let account = dir.path().join("claude-accounts/a1/.credentials.json");
    assert_eq!(get_code(&query("/fs/read", &account)).await, forbidden());

    let resp = get_request(
        test_state(),
        &query("/fs/read", &dir.path().join("notes.txt")),
    )
    .await;
    let body: IpcBody<FileContentDto> = body_as_json(resp.into_body()).await;
    assert_eq!(body.data.unwrap().content, "ordinary");
}

#[cfg(unix)]
#[tokio::test]
async fn read_refuses_a_symlink_to_the_credential() {
    let dir = state_dir("secret-link");
    let elsewhere = TempDir::new("secret-link-out");
    let link = elsewhere.path().join("innocent.txt");
    std::os::unix::fs::symlink(dir.path().join(HOST_LOCAL_TOKEN_FILE), &link).unwrap();
    assert_eq!(get_code(&query("/fs/read", &link)).await, forbidden());
}

#[tokio::test]
async fn info_refuses_the_credential() {
    let dir = state_dir("secret-info");
    let token = dir.path().join(HOST_LOCAL_TOKEN_FILE);
    assert_eq!(get_code(&query("/fs/info", &token)).await, forbidden());
    assert_eq!(
        get_code(&query("/fs/info", &dir.path().join("notes.txt"))).await,
        None
    );
}

#[tokio::test]
async fn listings_hide_the_credentials_and_refuse_the_account_dir() {
    let dir = state_dir("secret-ls");
    for route in ["/fs/ls", "/fs/browse"] {
        let resp = get_request(test_state(), &query(route, dir.path())).await;
        let body: IpcBody<Vec<DirectoryEntryDto>> = body_as_json(resp.into_body()).await;
        let names: Vec<String> = body.data.unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["notes.txt".to_string()], "{route}");
        let accounts = dir.path().join("claude-accounts");
        assert_eq!(
            get_code(&query(route, &accounts)).await,
            forbidden(),
            "{route}"
        );
    }
}

#[tokio::test]
async fn writes_and_deletes_of_a_credential_are_refused() {
    let dir = state_dir("secret-write");
    let token = dir.path().join(HOST_LOCAL_TOKEN_FILE);
    let token_str = token.to_string_lossy().into_owned();
    let write = serde_json::json!({ "path": token_str, "content": "attacker" });
    assert_eq!(post_code("/fs/write", write).await, forbidden());
    let delete = serde_json::json!({ "path": token_str });
    assert_eq!(post_code("/fs/delete", delete).await, forbidden());
    let nested = dir.path().join("claude-accounts/a2");
    let mkdir = serde_json::json!({ "path": nested.to_string_lossy() });
    assert_eq!(post_code("/fs/mkdir", mkdir).await, forbidden());
    assert_eq!(fs::read_to_string(&token).unwrap(), CREDENTIAL);
    assert!(!nested.exists());
}

#[tokio::test]
async fn copy_and_rename_never_carry_a_credential_out() {
    let dir = state_dir("secret-copy");
    let out = TempDir::new("secret-copy-out");
    let token = dir.path().join(HOST_LOCAL_TOKEN_FILE);
    let stolen = out.path().join("stolen");
    for route in ["/fs/copy", "/fs/rename"] {
        let from_token = serde_json::json!({ "from": token, "to": stolen });
        assert_eq!(
            post_code(route, from_token).await,
            forbidden(),
            "{route} from"
        );
        let onto_token = serde_json::json!({ "from": dir.path().join("notes.txt"), "to": token });
        assert_eq!(
            post_code(route, onto_token).await,
            forbidden(),
            "{route} onto"
        );
    }
    let move_dir = serde_json::json!({ "from": dir.path(), "to": out.path().join("moved") });
    assert_eq!(
        post_code("/fs/rename", move_dir).await,
        forbidden(),
        "the dir holding it"
    );
    assert!(!stolen.exists());
    assert_eq!(fs::read_to_string(&token).unwrap(), CREDENTIAL);

    let copy_ok = serde_json::json!({ "from": dir.path().join("notes.txt"), "to": stolen });
    assert_eq!(post_code("/fs/copy", copy_ok).await, None);
    assert_eq!(fs::read_to_string(&stolen).unwrap(), "ordinary");
}
