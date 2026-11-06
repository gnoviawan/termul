//! `authenticate_agent` with a typed API key on both carriers: the browser
//! `/ws` socket and the desktop Channel share one payload contract.

use super::carrier::Peer;
use super::wire::{authenticate, command_request, ChannelPeer, Wire};
use super::*;

const KEY: &str = "sk-termul-test-not-real";

/// An agent whose `authenticate` answers ok immediately.
fn signing_in_host() -> Host {
    Host::new(|acp, sessions| {
        acp.install_test_agent_with_turns(AgentId(AGENT.to_string()), sessions, Vec::new(), false);
    })
}

/// A key is accepted; a blank key or a key beside a gateway is refused, and
/// the refusal never repeats the key.
async fn an_api_key_sign_in_is_carried_and_checked<W: Wire>() {
    let host = signing_in_host();
    let mut wire = W::open(&host);
    authenticate(&mut wire).await;

    let signed_in = command_request(
        &mut wire,
        "k1",
        "authenticate_agent",
        json!({ "agentId": AGENT, "methodId": "api-key", "apiKey": KEY }),
        "cmd-k1",
    )
    .await;
    assert_eq!(
        signed_in["ok"],
        true,
        "{}",
        signed_in.to_string().replace(KEY, "<key>")
    );

    for (id, payload) in [
        (
            "k2",
            json!({ "agentId": AGENT, "methodId": "api-key", "apiKey": "  " }),
        ),
        (
            "k3",
            json!({ "agentId": AGENT, "methodId": "gateway", "apiKey": KEY,
                    "gateway": { "baseUrl": "https://gw" } }),
        ),
    ] {
        let command_id = format!("cmd-{id}");
        let refused =
            command_request(&mut wire, id, "authenticate_agent", payload, &command_id).await;
        let text = refused.to_string();
        assert!(!text.contains(KEY), "the refusal repeats the key");
        assert_eq!(refused["err"]["code"], "VALIDATION_ERROR", "{text}");
    }
}
on_both_carriers!(an_api_key_sign_in_is_carried_and_checked);
