use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex as StdMutex};

use anyhow::{anyhow, Context, Result};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct SshLaunchConfig {
    pub host: String,
    pub port: i64,
    pub username: String,
    pub strict_host_key: bool,
    pub key_path: Option<String>,
    pub password: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone)]
pub enum SshEvent {
    Stdout(String),
    Exit(i32),
}

#[derive(Clone)]
pub struct SshSessionManager {
    sessions: Arc<Mutex<HashMap<String, SessionHandle>>>,
}

struct SessionHandle {
    writer: Arc<StdMutex<Box<dyn Write + Send>>>,
    master: Arc<StdMutex<Box<dyn MasterPty + Send>>>,
    killer: Arc<StdMutex<Box<dyn ChildKiller + Send + Sync>>>,
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
        let pty_system = native_pty_system();
        let pty_pair = pty_system
            .openpty(PtySize {
                rows: config.rows.max(1),
                cols: config.cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("creating SSH PTY")?;

        let mut command = CommandBuilder::new("ssh");
        command.arg("-p");
        command.arg(config.port.to_string());

        if !config.strict_host_key {
            #[cfg(target_os = "windows")]
            let known_hosts_sink = "NUL";
            #[cfg(not(target_os = "windows"))]
            let known_hosts_sink = "/dev/null";

            command.arg("-o");
            command.arg("StrictHostKeyChecking=no");
            command.arg("-o");
            command.arg(format!("UserKnownHostsFile={known_hosts_sink}"));
        }

        if let Some(key_path) = &config.key_path {
            command.arg("-i");
            command.arg(key_path);
        }

        command.arg(format!("{}@{}", config.username, config.host));

        let mut child = pty_pair
            .slave
            .spawn_command(command)
            .context("spawning ssh process")?;
        let killer = child.clone_killer();
        drop(pty_pair.slave);

        let mut reader = pty_pair
            .master
            .try_clone_reader()
            .context("attaching ssh PTY reader")?;
        let writer = pty_pair
            .master
            .take_writer()
            .context("attaching ssh PTY writer")?;
        let master = pty_pair.master;

        let session_id = Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::unbounded_channel();

        let sessions_for_cleanup = self.sessions.clone();
        let session_for_wait = session_id.clone();
        let tx_for_wait = tx.clone();
        std::thread::spawn(move || {
            let exit_code = match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(_) => -1,
            };
            let _ = tx_for_wait.send(SshEvent::Exit(exit_code));
            let mut sessions = sessions_for_cleanup.blocking_lock();
            sessions.remove(&session_for_wait);
        });

        let tx_stdout = tx.clone();
        std::thread::spawn(move || {
            let mut buf = [0_u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = tx_stdout.send(SshEvent::Stdout(chunk));
                    }
                    Err(_) => break,
                }
            }
        });

        let mut sessions = self.sessions.lock().await;
        sessions.insert(
            session_id.clone(),
            SessionHandle {
                writer: Arc::new(StdMutex::new(writer)),
                master: Arc::new(StdMutex::new(master)),
                killer: Arc::new(StdMutex::new(killer)),
            },
        );

        Ok((session_id, rx))
    }

    pub async fn write(&self, session_id: &str, data: &str) -> Result<()> {
        let handle = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .ok_or_else(|| anyhow!("unknown ssh session: {session_id}"))?
                .writer
                .clone()
        };

        let payload = data.to_string();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut writer = handle
                .lock()
                .map_err(|_| anyhow!("ssh session writer lock poisoned"))?;
            writer
                .write_all(payload.as_bytes())
                .context("writing ssh session input")?;
            writer.flush().context("flushing ssh stdin")?;
            Ok(())
        })
        .await
        .context("joining ssh write task")??;

        Ok(())
    }

    pub async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<()> {
        let handle = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .ok_or_else(|| anyhow!("unknown ssh session: {session_id}"))?
                .master
                .clone()
        };

        tokio::task::spawn_blocking(move || -> Result<()> {
            let master = handle
                .lock()
                .map_err(|_| anyhow!("ssh session master lock poisoned"))?;
            master
                .resize(PtySize {
                    rows: rows.max(1),
                    cols: cols.max(1),
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .context("resizing ssh PTY")?;
            Ok(())
        })
        .await
        .context("joining ssh resize task")??;

        Ok(())
    }

    pub async fn close(&self, session_id: &str) -> Result<()> {
        let handle = {
            let mut sessions = self.sessions.lock().await;
            sessions
                .remove(session_id)
                .ok_or_else(|| anyhow!("unknown ssh session: {session_id}"))?
        };

        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut killer = handle
                .killer
                .lock()
                .map_err(|_| anyhow!("ssh session killer lock poisoned"))?;
            killer.kill().context("killing ssh session")?;
            Ok(())
        })
        .await
        .context("joining ssh close task")??;

        Ok(())
    }
}

impl Default for SshSessionManager {
    fn default() -> Self {
        Self::new()
    }
}
