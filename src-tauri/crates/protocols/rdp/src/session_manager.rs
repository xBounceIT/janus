use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

use crate::session_task;

#[derive(Debug, Clone)]
pub struct RdpSessionConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub domain: Option<String>,
    pub width: u16,
    pub height: u16,
}

#[derive(Debug)]
pub enum RdpEvent {
    /// JPEG-encoded frame data
    Frame { data: Vec<u8> },
    /// Session ended with a reason
    Exit { reason: String },
}

pub(crate) enum SessionCommand {
    MouseEvent {
        x: u16,
        y: u16,
        buttons: u8,
        prev_buttons: u8,
        wheel_delta: i16,
    },
    KeyEvent {
        scancode: u16,
        extended: bool,
        is_release: bool,
    },
    Close,
}

struct SessionHandle {
    cmd_tx: mpsc::UnboundedSender<SessionCommand>,
    task_handle: tokio::task::JoinHandle<()>,
    /// Track last button state for press/release detection
    last_buttons: u8,
}

#[derive(Clone)]
pub struct RdpSessionManager {
    sessions: Arc<Mutex<HashMap<String, SessionHandle>>>,
}

impl RdpSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn open_session(
        &self,
        config: &RdpSessionConfig,
    ) -> Result<(String, mpsc::UnboundedReceiver<RdpEvent>)> {
        let session_id = Uuid::new_v4().to_string();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<SessionCommand>();

        let config = config.clone();
        let task_handle = tokio::spawn(async move {
            session_task::run_session(config, event_tx, cmd_rx).await;
        });

        let mut sessions = self.sessions.lock().await;
        sessions.insert(
            session_id.clone(),
            SessionHandle {
                cmd_tx,
                task_handle,
                last_buttons: 0,
            },
        );

        Ok((session_id, event_rx))
    }

    pub async fn send_mouse(
        &self,
        session_id: &str,
        x: u16,
        y: u16,
        buttons: u8,
        wheel_delta: i16,
    ) -> Result<()> {
        let (tx, prev_buttons) = {
            let mut sessions = self.sessions.lock().await;
            let handle = sessions
                .get_mut(session_id)
                .ok_or_else(|| anyhow!("unknown rdp session: {session_id}"))?;
            let prev = handle.last_buttons;
            handle.last_buttons = buttons;
            (handle.cmd_tx.clone(), prev)
        };

        tx.send(SessionCommand::MouseEvent {
            x,
            y,
            buttons,
            prev_buttons,
            wheel_delta,
        })
        .map_err(|_| anyhow!("rdp session channel closed"))?;

        Ok(())
    }

    pub async fn send_key(
        &self,
        session_id: &str,
        scancode: u16,
        extended: bool,
        is_release: bool,
    ) -> Result<()> {
        let tx = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .ok_or_else(|| anyhow!("unknown rdp session: {session_id}"))?
                .cmd_tx
                .clone()
        };

        tx.send(SessionCommand::KeyEvent {
            scancode,
            extended,
            is_release,
        })
        .map_err(|_| anyhow!("rdp session channel closed"))?;

        Ok(())
    }

    pub async fn close(&self, session_id: &str) -> Result<()> {
        let handle = {
            let mut sessions = self.sessions.lock().await;
            sessions
                .remove(session_id)
                .ok_or_else(|| anyhow!("unknown rdp session: {session_id}"))?
        };

        let _ = handle.cmd_tx.send(SessionCommand::Close);

        if tokio::time::timeout(std::time::Duration::from_secs(2), handle.task_handle)
            .await
            .is_err()
        {
            tracing::debug!("rdp session task did not exit within 2s, aborting");
        }

        Ok(())
    }
}

impl Default for RdpSessionManager {
    fn default() -> Self {
        Self::new()
    }
}
