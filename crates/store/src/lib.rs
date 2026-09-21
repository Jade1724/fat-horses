//! Store implementations (SPEC.md §4.2).

pub mod contract;
pub mod dynamo;
pub mod file;
pub mod memory;
mod state;

pub use dynamo::DynamoStore;
pub use file::FileStore;
pub use memory::MemoryStore;
