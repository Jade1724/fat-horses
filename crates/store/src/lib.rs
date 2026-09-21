//! Store implementations (SPEC.md §4.2).

pub mod contract;
pub mod file;
pub mod memory;
mod state;

pub use file::FileStore;
pub use memory::MemoryStore;
