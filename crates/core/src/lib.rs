//! Authoritative local state and business rules for DitaList.
mod domain;
mod focus;
mod import;
mod navigation;
mod reminders;
mod service;
mod storage;
mod validation;

pub use ditalist_contracts::*;
pub use service::CoreService;
