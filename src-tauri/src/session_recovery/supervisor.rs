use parking_lot::RwLock;
use std::sync::Arc;

pub fn supervisor_binary_name() -> &'static str {
    "termul-supervisor"
}

#[derive(Debug, Default)]
pub struct SupervisorClientState {
    pub supervisor_pid: Option<u32>,
    registry: Arc<RwLock<Option<crate::session_recovery::registry::SessionRegistry>>>,
}

impl SupervisorClientState {
    pub fn recovered_sessions(&self) -> Vec<crate::session_recovery::registry::RecoveredSession> {
        self.registry
            .read()
            .as_ref()
            .map(|registry| registry.sessions.clone())
            .unwrap_or_default()
    }

    pub fn set_registry(&self, registry: crate::session_recovery::registry::SessionRegistry) {
        *self.registry.write() = Some(registry);
    }
}

pub fn registry_path(base_dir: &std::path::Path) -> std::path::PathBuf {
    base_dir.join("sessions.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervisor_binary_name_is_stable() {
        assert_eq!(supervisor_binary_name(), "termul-supervisor");
    }

    #[test]
    fn registry_filename_is_sessions_json() {
        let base = std::path::PathBuf::from("/tmp/termul-test");
        assert_eq!(registry_path(&base), base.join("sessions.json"));
    }

    #[test]
    fn recovered_sessions_defaults_empty_then_reflects_registry() {
        use crate::session_recovery::registry::SessionRegistry;

        let state = SupervisorClientState::default();
        assert!(state.recovered_sessions().is_empty());

        let registry = SessionRegistry::new(123);
        state.set_registry(registry);
        assert!(state.recovered_sessions().is_empty());
    }
}
