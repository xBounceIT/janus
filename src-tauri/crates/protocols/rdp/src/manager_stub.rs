use anyhow::{bail, Result};
use tokio::sync::mpsc;

#[derive(Debug, Clone)]
pub struct RdpSessionConfig {
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub domain: Option<String>,
    pub width: Option<u16>,
    pub height: Option<u16>,
}

#[derive(Debug, Clone)]
pub enum RdpActiveXEvent {
    Connecting {
        session_id: String,
    },
    Connected {
        session_id: String,
    },
    LoginComplete {
        session_id: String,
    },
    Disconnected {
        session_id: String,
        reason: i32,
    },
    FatalError {
        session_id: String,
        error_code: i32,
    },
    HostInitFailed {
        session_id: String,
        stage: String,
        hresult: Option<i32>,
        message: String,
    },
}

#[derive(Clone, Default)]
pub struct RdpActiveXManager;

impl RdpActiveXManager {
    pub fn new() -> Self {
        Self
    }

    pub async fn create_session(
        &self,
        _session_id: &str,
        _parent_hwnd: isize,
        _config: &RdpSessionConfig,
        _event_tx: mpsc::UnboundedSender<RdpActiveXEvent>,
    ) -> Result<()> {
        bail!("RDP ActiveX is only supported on Windows")
    }

    pub fn reposition(
        &self,
        _session_id: &str,
        _x: i32,
        _y: i32,
        _width: i32,
        _height: i32,
    ) -> Result<()> {
        bail!("RDP ActiveX is only supported on Windows")
    }

    pub fn show(&self, _session_id: &str) -> Result<()> {
        bail!("RDP ActiveX is only supported on Windows")
    }

    pub fn hide(&self, _session_id: &str) -> Result<()> {
        bail!("RDP ActiveX is only supported on Windows")
    }

    pub async fn close(&self, _session_id: &str) -> Result<()> {
        bail!("RDP ActiveX is only supported on Windows")
    }
}
