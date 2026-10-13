//! The Tauri `invoke` surface of the Channel carrier. Commands only open /
//! enqueue / close; every reply and event arrives on the Channel.

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{State, Webview};

use super::{FrameSink, WsChannelHost};

/// Open one relay connection. `onFrame` receives ONE string per message: the
/// exact JSON text a `/ws` socket would carry, `auth_required` first. Returns
/// the connection id used by [`ws_channel_send`] / [`ws_channel_close`].
#[tauri::command]
pub async fn ws_channel_open(
    host: State<'_, WsChannelHost>,
    webview: Webview,
    on_frame: Channel<String>,
) -> Result<u64, String> {
    let send: FrameSink = Arc::new(move |frame| on_frame.send(frame).map_err(|e| e.to_string()));
    host.open(webview.window().label(), send)
        .map_err(|error| error.to_string())
}

/// Enqueue one inbound text frame (a request, or an id-less
/// `background`/`foreground` control frame) for `connection_id`. Ack only.
///
/// Deliberately a synchronous command: Tauri runs those in invoke-arrival
/// order, so frames of one connection are enqueued in the order the renderer
/// sent them (an async command could be scheduled out of order).
#[tauri::command]
pub fn ws_channel_send(
    host: State<'_, WsChannelHost>,
    connection_id: u64,
    frame: String,
) -> Result<(), String> {
    host.send(connection_id, frame)
        .map_err(|error| error.to_string())
}

/// Close one connection. Idempotent: unknown ids are ignored.
#[tauri::command]
pub fn ws_channel_close(host: State<'_, WsChannelHost>, connection_id: u64) {
    host.close(connection_id);
}
