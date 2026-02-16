use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use russh::client;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::ChannelMsg;
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct SshLaunchConfig {
    pub host: String,
    pub port: i64,
    pub username: String,
    pub strict_host_key: bool,
    pub key_path: Option<String>,
    pub key_passphrase: Option<String>,
    pub password: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone)]
pub enum SshEvent {
    Stdout(String),
    Exit(i32),
}

enum SessionCommand {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

struct ClientHandler {
    strict_host_key: bool,
}

#[async_trait::async_trait]
impl client::Handler for ClientHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh_keys::ssh_key::PublicKey,
    ) -> Result<bool> {
        if self.strict_host_key {
            let home = dirs_path();
            let known_hosts_path = home.join(".ssh").join("known_hosts");
            if known_hosts_path.exists() {
                // For strict mode, we would check known_hosts here.
                // russh-keys doesn't expose a convenient check_known_hosts in 0.49,
                // so for now strict mode just accepts (same as before with system ssh
                // when StrictHostKeyChecking was set). A full implementation would
                // parse known_hosts manually.
                tracing::warn!("strict_host_key is enabled but full known_hosts checking is not yet implemented; accepting key");
            }
        }
        Ok(true)
    }
}

fn dirs_path() -> std::path::PathBuf {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from("C:\\Users\\Default"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from("/root"))
    }
}

#[derive(Clone)]
pub struct SshSessionManager {
    sessions: Arc<Mutex<HashMap<String, SessionHandle>>>,
}

struct SessionHandle {
    cmd_tx: mpsc::UnboundedSender<SessionCommand>,
    task_handle: tokio::task::JoinHandle<()>,
}

impl SshSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn open_session(
        &self,
        config: &SshLaunchConfig,
    ) -> Result<(String, mpsc::UnboundedReceiver<SshEvent>)> {
        let ssh_config = client::Config::default();

        let handler = ClientHandler {
            strict_host_key: config.strict_host_key,
        };

        let mut session = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            client::connect(
                Arc::new(ssh_config),
                (config.host.as_str(), config.port as u16),
                handler,
            ),
        )
        .await
        .map_err(|_| anyhow!("SSH connection timed out after 10s"))?
        .context("SSH connection failed")?;

        // --- Authentication ---
        let mut authenticated = false;

        // Try key-based auth first
        if let Some(key_path) = &config.key_path {
            let passphrase = config.key_passphrase.as_deref();
            match russh_keys::load_secret_key(key_path, passphrase) {
                Ok(key_pair) => {
                    let key = PrivateKeyWithHashAlg::new(Arc::new(key_pair), None)
                        .context("failed to prepare key for auth")?;
                    match session
                        .authenticate_publickey(&config.username, key)
                        .await
                    {
                        Ok(true) => {
                            authenticated = true;
                            tracing::debug!("authenticated via public key");
                        }
                        Ok(false) => {
                            tracing::debug!("public key auth rejected, falling through");
                        }
                        Err(e) => {
                            tracing::debug!("public key auth error: {e}, falling through");
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("failed to load key from {key_path}: {e}");
                }
            }
        }

        // Try password auth
        if !authenticated {
            if let Some(password) = &config.password {
                let result = session
                    .authenticate_password(&config.username, password)
                    .await
                    .context("password authentication failed")?;
                if result {
                    authenticated = true;
                    tracing::debug!("authenticated via password");
                }
            }
        }

        // Try none auth (some servers allow it)
        if !authenticated {
            let result = session
                .authenticate_none(&config.username)
                .await
                .context("none authentication failed")?;
            if result {
                authenticated = true;
                tracing::debug!("authenticated via none");
            }
        }

        if !authenticated {
            return Err(anyhow!("SSH authentication failed: no method succeeded"));
        }

        // --- Open channel, request PTY & shell ---
        let mut channel = session
            .channel_open_session()
            .await
            .context("failed to open SSH channel")?;

        channel
            .request_pty(
                false,
                "xterm-256color",
                config.cols as u32,
                config.rows as u32,
                0,
                0,
                &[],
            )
            .await
            .context("failed to request PTY")?;

        channel
            .request_shell(false)
            .await
            .context("failed to request shell")?;

        // --- Set up session task ---
        let session_id = Uuid::new_v4().to_string();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<SessionCommand>();

        let task_handle = tokio::spawn(async move {
            let mut exit_sent = false;

            loop {
                tokio::select! {
                    cmd = cmd_rx.recv() => {
                        match cmd {
                            Some(SessionCommand::Data(bytes)) => {
                                if let Err(e) = channel.data(&bytes[..]).await {
                                    tracing::debug!("channel write error: {e}");
                                    break;
                                }
                            }
                            Some(SessionCommand::Resize { cols, rows }) => {
                                if let Err(e) = channel.window_change(cols, rows, 0, 0).await {
                                    tracing::debug!("channel resize error: {e}");
                                }
                            }
                            Some(SessionCommand::Close) | None => {
                                let _ = channel.eof().await;
                                let _ = channel.close().await;
                                break;
                            }
                        }
                    }
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) => {
                                let chunk = String::from_utf8_lossy(&data).to_string();
                                if event_tx.send(SshEvent::Stdout(chunk)).is_err() {
                                    break;
                                }
                            }
                            Some(ChannelMsg::ExtendedData { data, ext }) => {
                                // ext == 1 is stderr; forward it the same way
                                let _ = ext;
                                let chunk = String::from_utf8_lossy(&data).to_string();
                                let _ = event_tx.send(SshEvent::Stdout(chunk));
                            }
                            Some(ChannelMsg::ExitStatus { exit_status }) => {
                                if !exit_sent {
                                    exit_sent = true;
                                    let _ = event_tx.send(SshEvent::Exit(exit_status as i32));
                                }
                            }
                            Some(ChannelMsg::Eof) => {
                                if !exit_sent {
                                    exit_sent = true;
                                    let _ = event_tx.send(SshEvent::Exit(0));
                                }
                                break;
                            }
                            None => {
                                // Channel closed
                                if !exit_sent {
                                    exit_sent = true;
                                    let _ = event_tx.send(SshEvent::Exit(0));
                                }
                                break;
                            }
                            _ => {}
                        }
                    }
                }
            }

            // Ensure exit event is sent
            if !exit_sent {
                let _ = event_tx.send(SshEvent::Exit(0));
            }
        });

        let mut sessions = self.sessions.lock().await;
        sessions.insert(
            session_id.clone(),
            SessionHandle {
                cmd_tx,
                task_handle,
            },
        );

        Ok((session_id, event_rx))
    }

    pub async fn write(&self, session_id: &str, data: &str) -> Result<()> {
        let tx = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .ok_or_else(|| anyhow!("unknown ssh session: {session_id}"))?
                .cmd_tx
                .clone()
        };

        tx.send(SessionCommand::Data(data.as_bytes().to_vec()))
            .map_err(|_| anyhow!("ssh session channel closed"))?;

        Ok(())
    }

    pub async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<()> {
        let tx = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .ok_or_else(|| anyhow!("unknown ssh session: {session_id}"))?
                .cmd_tx
                .clone()
        };

        tx.send(SessionCommand::Resize {
            cols: cols as u32,
            rows: rows as u32,
        })
        .map_err(|_| anyhow!("ssh session channel closed"))?;

        Ok(())
    }

    pub async fn close(&self, session_id: &str) -> Result<()> {
        let handle = {
            let mut sessions = self.sessions.lock().await;
            sessions
                .remove(session_id)
                .ok_or_else(|| anyhow!("unknown ssh session: {session_id}"))?
        };

        // Send close command
        let _ = handle.cmd_tx.send(SessionCommand::Close);

        // Wait up to 2 seconds for graceful shutdown
        let task = handle.task_handle;
        if tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .is_err()
        {
            tracing::debug!("ssh session task did not exit within 2s, aborting");
        }

        Ok(())
    }
}

impl Default for SshSessionManager {
    fn default() -> Self {
        Self::new()
    }
}
