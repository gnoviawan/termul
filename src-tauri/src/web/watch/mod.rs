//! The watch hub (`watch` / `unwatch` requests, `{"type":"watch"}` frames).
//!
//! State that is not a session log — the project list, the chat-history index,
//! the agent roster — reaches a client through a watch instead of a `seq = 0`
//! broadcast a client could miss, receive twice, or never receive on a socket
//! without a session subscription. A watch sends the full state first, then
//! deltas under a contiguous `(hostEpoch, n)` revision; the client repairs any
//! discontinuity by resubscribing. See [`hub`] for delivery and [`sources`]
//! for what each watch carries.

mod hub;
mod sources;

pub use hub::{
    SubscribeError, WatchFrame, WatchHub, WatchKind, WatchRevision, WS_WATCH_TYPE,
};
pub use sources::{
    agents_state, chat_history_state, projects_state, publish_agent_event,
    publish_chat_history, publish_projects, AGENT_ROSTER_EVENTS,
};

#[cfg(test)]
mod tests;
