#[cfg(windows)]
mod com_interfaces;
#[cfg(windows)]
mod dispatch_helpers;
#[cfg(windows)]
mod event_sink;
#[cfg(windows)]
mod manager;
#[cfg(windows)]
mod ole_container;
#[cfg(windows)]
mod session;
#[cfg(windows)]
mod sta_thread;
#[cfg(not(windows))]
mod manager_stub;

#[cfg(windows)]
pub use manager::{RdpActiveXEvent, RdpActiveXManager, RdpSessionConfig};
#[cfg(not(windows))]
pub use manager_stub::{RdpActiveXEvent, RdpActiveXManager, RdpSessionConfig};
