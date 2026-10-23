//! SSH `/ws` requests: the desktop's SSH Tauri commands, served by the
//! standalone server through the same `ssh::service` operations. Each
//! request type is the Tauri command name and its payload is that command's
//! arguments (`{ request }`, `{ profileId }`, `{ sessionId, trust }`, ...).
//! A success answers the command's value; a failure answers the service's
//! stable code (`SSH_AUTH_FAILED`, `SFTP_ERROR`, ...) with its message.
//!
//! The capability check admits these only for a `host_local` connection:
//! they use the host's SSH keys, keychain and known_hosts. Payloads can carry
//! a password or passphrase, so nothing here logs them.

use super::*;
use crate::ssh::service::{self, SshFailure, SshResult};
use crate::ssh::SSHManager;
use serde::de::DeserializeOwned;

/// Every SSH request type, in the order of the Tauri commands.
pub const SSH_WS_REQUESTS: &[&str] = &[
    "ssh_list_profiles",
    "ssh_save_profile",
    "ssh_delete_profile",
    "ssh_duplicate_profile",
    "ssh_import_config",
    "ssh_inspect_key",
    "ssh_list_keys",
    "ssh_session_open",
    "ssh_session_respond_host_key",
    "ssh_session_cancel",
    "ssh_session_close",
    "ssh_session_list",
    "sftp_list_dir",
    "sftp_realpath",
    "sftp_download",
    "sftp_upload",
    "sftp_delete",
    "sftp_mkdir",
    "sftp_rename",
    "sftp_read_file",
    "sftp_write_file",
    "sftp_create_file",
];

#[derive(Deserialize)]
struct RequestArg<T> {
    request: T,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileIdArg {
    profile_id: String,
}

#[derive(Deserialize)]
struct ProfileArg {
    profile: crate::ssh::profile_manager::SSHProfile,
}

#[derive(Deserialize)]
struct PathArg {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionIdArg {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostKeyArg {
    session_id: String,
    trust: bool,
}

/// Parse the payload. The serde error names the field, never its value.
fn args<T: DeserializeOwned>(request_type: &str, payload: &Value) -> SshResult<T> {
    serde_json::from_value(payload.clone()).map_err(|error| {
        SshFailure::new(
            format!("malformed {request_type} payload: {error}"),
            "SSH_INVALID_REQUEST",
        )
    })
}

fn value<T: serde::Serialize>(result: SshResult<T>) -> SshResult<Value> {
    result.and_then(|v| {
        serde_json::to_value(v).map_err(|e| SshFailure::new(e.to_string(), "SSH_INTERNAL"))
    })
}

async fn run(
    ssh: &SSHManager,
    pty: &PtyManager,
    request_type: &str,
    payload: &Value,
) -> SshResult<Value> {
    match request_type {
        "ssh_list_profiles" => value(service::list_profiles(ssh)),
        "ssh_save_profile" => {
            let a: ProfileArg = args(request_type, payload)?;
            value(service::save_profile(ssh, a.profile))
        }
        "ssh_delete_profile" => {
            let a: ProfileIdArg = args(request_type, payload)?;
            value(service::delete_profile(ssh, &a.profile_id))
        }
        "ssh_duplicate_profile" => {
            let a: ProfileIdArg = args(request_type, payload)?;
            value(service::duplicate_profile(ssh, &a.profile_id))
        }
        "ssh_import_config" => value(service::import_config(ssh)),
        "ssh_inspect_key" => {
            let a: PathArg = args(request_type, payload)?;
            value(Ok(service::inspect_key(&a.path)))
        }
        "ssh_list_keys" => value(Ok(service::list_keys())),
        "ssh_session_open" => {
            let a: RequestArg<service::SSHSessionOpenRequest> = args(request_type, payload)?;
            value(service::open_session(ssh, pty, a.request).await)
        }
        "ssh_session_respond_host_key" => {
            let a: HostKeyArg = args(request_type, payload)?;
            value(Ok(service::respond_host_key(ssh, &a.session_id, a.trust)))
        }
        "ssh_session_cancel" => {
            let a: SessionIdArg = args(request_type, payload)?;
            value(Ok(service::cancel_session(ssh, &a.session_id)))
        }
        "ssh_session_close" => {
            let a: SessionIdArg = args(request_type, payload)?;
            value(service::close_session(ssh, pty, &a.session_id).await)
        }
        "ssh_session_list" => value(Ok(service::list_sessions(ssh, pty))),
        "sftp_list_dir" => {
            let a: RequestArg<_> = args(request_type, payload)?;
            value(service::sftp_list_dir(ssh, a.request).await)
        }
        "sftp_realpath" => {
            let a: RequestArg<_> = args(request_type, payload)?;
            value(service::sftp_realpath(ssh, a.request).await)
        }
        "sftp_download" => {
            let a: RequestArg<_> = args(request_type, payload)?;
            value(service::sftp_download(ssh, a.request).await)
        }
        "sftp_upload" => {
            let a: RequestArg<_> = args(request_type, payload)?;
            value(service::sftp_upload(ssh, a.request).await)
        }
        "sftp_delete" => {
            let a: RequestArg<_> = args(request_type, payload)?;
            value(service::sftp_delete(ssh, a.request).await)
        }
        "sftp_mkdir" => {
            let a: RequestArg<_> = args(request_type, payload)?;
            value(service::sftp_mkdir(ssh, a.request).await)
        }
        "sftp_rename" => {
            let a: RequestArg<_> = args(request_type, payload)?;
            value(service::sftp_rename(ssh, a.request).await)
        }
        "sftp_read_file" => {
            let a: RequestArg<_> = args(request_type, payload)?;
            value(service::sftp_read_file(ssh, a.request).await)
        }
        "sftp_write_file" => {
            let a: RequestArg<_> = args(request_type, payload)?;
            value(service::sftp_write_file(ssh, a.request).await)
        }
        "sftp_create_file" => {
            let a: RequestArg<_> = args(request_type, payload)?;
            value(service::sftp_create_file(ssh, a.request).await)
        }
        other => Err(SshFailure::new(
            format!("unknown SSH request `{other}`"),
            "SSH_INVALID_REQUEST",
        )),
    }
}

/// Run one SSH request on the host's SSH manager.
pub(super) async fn handle_ssh_request(
    id: String,
    request_type: &str,
    payload: &Value,
    env: &HandlerEnv,
) -> WsReply {
    let Some(ssh) = env.relay.ssh() else {
        return WsReply::err(id, WsErrorCode::Unsupported, "this host does not serve SSH");
    };
    match run(&ssh, &env.pty, request_type, payload).await {
        Ok(value) => WsReply::ok(id, Some(value)),
        Err(failure) => {
            // The code and the request type only: messages can name remote
            // paths or hosts, payloads can carry secrets.
            warn!(request = request_type, code = failure.code, "SSH request over ws failed");
            WsReply::err_with_code(id, failure.code, failure.message)
        }
    }
}

#[cfg(test)]
#[path = "ssh_tests.rs"]
mod tests;
