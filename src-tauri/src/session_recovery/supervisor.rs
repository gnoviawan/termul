pub fn supervisor_binary_name() -> &'static str {
    "termul-supervisor"
}

#[derive(Debug, Default)]
pub struct SupervisorClientState {
    pub supervisor_pid: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervisor_binary_name_is_stable() {
        assert_eq!(supervisor_binary_name(), "termul-supervisor");
    }
}
