//! Chat-authored automations: a validated node graph run by the host on a
//! schedule or on demand. This module holds the model, the pure rules,
//! the SQLite store, the run engine and the host service the transports
//! call.

pub mod agents;
pub mod engine;
pub mod graph;
pub mod model;
pub mod policy;
pub mod schedule;
pub mod schema;
pub mod secrets;
pub mod service;
pub mod store;
pub mod template;

#[cfg(test)]
mod agents_tests;
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
mod secrets_tests;
#[cfg(test)]
mod service_tests;
#[cfg(test)]
mod store_tests;
#[cfg(test)]
mod template_tests;
#[cfg(test)]
pub(crate) mod test_support;
