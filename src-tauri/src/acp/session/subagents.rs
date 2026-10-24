//! Native subagent sessions (Claude Agent ACP `subagents` capability).
//!
//! The adapter runs each subagent in its own ACP session and sends that
//! session's traffic (updates, permission requests, questions) under the
//! child session id. Termul shows a subagent inside its parent chat, so the
//! driver maps every child session to its root chat session and to the
//! dispatch card that the host synthesizes for it.

use std::collections::HashMap;

/// Children kept per connection. A long chat can spawn many subagents; past
/// this bound the oldest ended routes go first.
const MAX_CHILD_ROUTES: usize = 1024;

/// Where one child session's traffic goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChildRoute {
    /// The chat session the user sees (never itself a child session).
    pub root_session_id: String,
    /// The synthesized dispatch tool call that represents the child.
    pub dispatch_id: String,
    /// The dispatch of the child that spawned this one (nested subagents).
    pub parent_dispatch_id: Option<String>,
    /// The child reported an end state.
    pub ended: bool,
}

#[derive(Default)]
pub(super) struct SubagentRoutes {
    children: HashMap<String, ChildRoute>,
    /// Registration order, for eviction.
    order: Vec<String>,
}

/// The dispatch tool call id for a child session.
pub(crate) fn dispatch_id_for(child_session_id: &str) -> String {
    format!("termul-subagent:{child_session_id}")
}

impl SubagentRoutes {
    pub(super) fn route(&self, session_id: &str) -> Option<&ChildRoute> {
        self.children.get(session_id)
    }

    /// The chat session for `session_id`: its root when it is a child,
    /// otherwise itself.
    pub(super) fn root_of<'a>(&'a self, session_id: &'a str) -> &'a str {
        self.children
            .get(session_id)
            .map_or(session_id, |route| route.root_session_id.as_str())
    }

    /// Record `child` as spawned from `parent` (a chat session or another
    /// child). Returns the new route, or the existing one when the child is
    /// already known. A child that names itself as parent is rejected.
    pub(super) fn register(&mut self, parent: &str, child: &str) -> Option<ChildRoute> {
        if parent == child || child.is_empty() {
            return None;
        }
        if let Some(existing) = self.children.get(child) {
            return Some(existing.clone());
        }
        let (root_session_id, parent_dispatch_id) = match self.children.get(parent) {
            Some(parent_route) => (
                parent_route.root_session_id.clone(),
                Some(parent_route.dispatch_id.clone()),
            ),
            None => (parent.to_string(), None),
        };
        let route = ChildRoute {
            root_session_id,
            dispatch_id: dispatch_id_for(child),
            parent_dispatch_id,
            ended: false,
        };
        self.evict_if_full();
        self.children.insert(child.to_string(), route.clone());
        self.order.push(child.to_string());
        Some(route)
    }

    /// Mark `child` ended. Its route stays so a late request still reaches
    /// the right chat. Returns the route when the child was known.
    pub(super) fn mark_ended(&mut self, child: &str) -> Option<ChildRoute> {
        let route = self.children.get_mut(child)?;
        route.ended = true;
        Some(route.clone())
    }

    /// Drop every child of `root` (the chat session closed or reloaded).
    pub(super) fn forget_root(&mut self, root: &str) {
        self.children
            .retain(|_, route| route.root_session_id != root);
        let children = &self.children;
        self.order.retain(|id| children.contains_key(id));
    }

    fn evict_if_full(&mut self) {
        if self.children.len() < MAX_CHILD_ROUTES {
            return;
        }
        let victim = self
            .order
            .iter()
            .position(|id| self.children.get(id).is_some_and(|route| route.ended))
            .unwrap_or(0);
        let id = self.order.remove(victim);
        self.children.remove(&id);
        log::warn!(
            "[acp] native subagent routes full ({MAX_CHILD_ROUTES}); dropped the oldest route"
        );
    }

    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.children.len()
    }
}

impl super::DriverState {
    /// Record a native subagent session spawned from `parent`.
    pub(crate) fn register_subagent(&mut self, parent: &str, child: &str) -> Option<ChildRoute> {
        self.subagents.register(parent, child)
    }

    /// Mark a native subagent session ended.
    pub(crate) fn end_subagent(&mut self, child: &str) -> Option<ChildRoute> {
        self.subagents.mark_ended(child)
    }

    /// The route of a native subagent session, `None` for a chat session.
    pub(crate) fn subagent_route(&self, session_id: &str) -> Option<ChildRoute> {
        self.subagents.route(session_id).cloned()
    }

    /// The chat session that owns `session_id`: the root of a native
    /// subagent session, otherwise `session_id` itself. Permission requests,
    /// questions, and elicitations from a subagent use this so the prompt
    /// appears in the chat the user sees.
    pub(crate) fn chat_session_for(&self, session_id: &str) -> String {
        self.subagents.root_of(session_id).to_string()
    }
}
