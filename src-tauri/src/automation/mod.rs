//! Chat-authored automations: a validated node graph run by the host on a
//! schedule or on demand. This module holds the model, the pure rules and
//! the SQLite store; the engine and transports build on it.

pub mod graph;
pub mod model;
pub mod policy;
pub mod schedule;
pub mod schema;
pub mod store;
pub mod template;

#[cfg(test)]
mod graph_tests;
#[cfg(test)]
mod model_tests;
#[cfg(test)]
mod policy_tests;
#[cfg(test)]
mod schedule_tests;
#[cfg(test)]
mod schema_tests;
#[cfg(test)]
mod store_tests;
#[cfg(test)]
mod template_tests;
#[cfg(test)]
mod test_support;
