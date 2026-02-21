/// Public API for the RDP ActiveX manager.
///
/// Provides async methods that dispatch to the STA thread via channels.
/// This is the only type exposed to the rest of the application.
use std::sync::mpsc as std_mpsc;
use std::thread;

use anyhow::Result;
use tokio::sync::{mpsc, oneshot};

use crate::sta_thread::{self, StaCommand};

/// Configuration for an RDP session.
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

/// Events emitted by the RDP ActiveX control.
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
}

/// Manages RDP ActiveX sessions.
///
/// Owns a dedicated STA thread for COM operations. All ActiveX interactions
/// are dispatched to this thread via a command channel.
#[derive(Clone)]
pub struct RdpActiveXManager {
    cmd_tx: std_mpsc::Sender<StaCommand>,
}

impl RdpActiveXManager {
    /// Create a new manager and spawn the STA thread.
    pub fn new() -> Self {
        let (cmd_tx, cmd_rx) = std_mpsc::channel();

        thread::Builder::new()
            .name("rdp-sta".into())
            .spawn(move || {
                sta_thread::run_sta_thread(cmd_rx);
            })
            .expect("failed to spawn RDP STA thread");

        Self { cmd_tx }
    }

    /// Create a new RDP session.
    ///
    /// Returns a session ID and an event receiver for session lifecycle events.
    pub async fn create_session(
        &self,
        session_id: &str,
        parent_hwnd: isize,
        config: &RdpSessionConfig,
        event_tx: mpsc::UnboundedSender<RdpActiveXEvent>,
    ) -> Result<()> {
        let (reply_tx, reply_rx) = oneshot::channel();

        self.cmd_tx
            .send(StaCommand::CreateSession {
                session_id: session_id.to_string(),
                parent_hwnd,
                config: config.clone(),
                event_tx,
                reply: reply_tx,
            })
            .map_err(|_| anyhow::anyhow!("RDP STA thread is not running"))?;

        reply_rx
            .await
            .map_err(|_| anyhow::anyhow!("RDP STA thread dropped reply channel"))?
            .map_err(|e| anyhow::anyhow!("{e}"))
    }

    /// Reposition the session's host window.
    pub fn reposition(
        &self,
        session_id: &str,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> Result<()> {
        self.cmd_tx
            .send(StaCommand::Reposition {
                session_id: session_id.to_string(),
                x,
                y,
                width,
                height,
            })
            .map_err(|_| anyhow::anyhow!("RDP STA thread is not running"))
    }

    /// Show the session's host window (bring to front).
    pub fn show(&self, session_id: &str) -> Result<()> {
        self.cmd_tx
            .send(StaCommand::Show {
                session_id: session_id.to_string(),
            })
            .map_err(|_| anyhow::anyhow!("RDP STA thread is not running"))
    }

    /// Hide the session's host window.
    pub fn hide(&self, session_id: &str) -> Result<()> {
        self.cmd_tx
            .send(StaCommand::Hide {
                session_id: session_id.to_string(),
            })
            .map_err(|_| anyhow::anyhow!("RDP STA thread is not running"))
    }

    /// Close and destroy an RDP session.
    pub async fn close(&self, session_id: &str) -> Result<()> {
        let (reply_tx, reply_rx) = oneshot::channel();

        self.cmd_tx
            .send(StaCommand::CloseSession {
                session_id: session_id.to_string(),
                reply: reply_tx,
            })
            .map_err(|_| anyhow::anyhow!("RDP STA thread is not running"))?;

        reply_rx
            .await
            .map_err(|_| anyhow::anyhow!("RDP STA thread dropped reply channel"))?
            .map_err(|e| anyhow::anyhow!("{e}"))
    }
}

impl Default for RdpActiveXManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for RdpActiveXManager {
    fn drop(&mut self) {
        let _ = self.cmd_tx.send(StaCommand::Shutdown);
    }
}
