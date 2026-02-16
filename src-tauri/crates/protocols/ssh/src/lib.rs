use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
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
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
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
        let mut command = Command::new("ssh");
        command.arg("-p").arg(config.port.to_string());

        if !config.strict_host_key {
            #[cfg(target_os = "windows")]
            let known_hosts_sink = "NUL";
            #[cfg(not(target_os = "windows"))]
            let known_hosts_sink = "/dev/null";

            command
                .arg("-o")
                .arg("StrictHostKeyChecking=no")
                .arg("-o")
                .arg(format!("UserKnownHostsFile={known_hosts_sink}"));
        }

        if let Some(key_path) = &config.key_path {
            command.arg("-i").arg(key_path);
        }

        command.arg(format!("{}@{}", config.username, config.host));

        command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = command.spawn().context("spawning ssh process")?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("failed to attach ssh stdin"))?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("failed to attach ssh stdout"))?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("failed to attach ssh stderr"))?;

        let stdin = Arc::new(Mutex::new(stdin));
        let child = Arc::new(Mutex::new(child));

        let session_id = Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::unbounded_channel();

        let sessions_for_cleanup = self.sessions.clone();
        let session_for_wait = session_id.clone();
        let tx_for_wait = tx.clone();
        let child_for_wait = child.clone();
        tokio::spawn(async move {
            let exit_code = {
                let mut guard = child_for_wait.lock().await;
                match guard.wait().await {
                    Ok(status) => status.code().unwrap_or(-1),
                    Err(_) => -1,
                }
            };
            let _ = tx_for_wait.send(SshEvent::Exit(exit_code));
            let mut sessions = sessions_for_cleanup.lock().await;
            sessions.remove(&session_for_wait);
        });

        let tx_stdout = tx.clone();
        tokio::spawn(async move {
            let mut buf = [0_u8; 4096];
            loop {
                match stdout.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = tx_stdout.send(SshEvent::Stdout(chunk));
                    }
                    Err(_) => break,
                }
            }
        });

        let tx_stderr = tx.clone();
        tokio::spawn(async move {
            let mut buf = [0_u8; 4096];
            loop {
                match stderr.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = tx_stderr.send(SshEvent::Stdout(chunk));
                    }
                    Err(_) => break,
                }
            }
        });

        if config.password.is_some() {
            let _ = tx.send(SshEvent::Stdout(
                "[info] password-auth is configured; if OpenSSH prompts, type password in terminal.\r\n"
                    .to_string(),
            ));
        }

        let mut sessions = self.sessions.lock().await;
        sessions.insert(
            session_id.clone(),
            SessionHandle {
                stdin,
                child,
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
                .stdin
                .clone()
        };

        let mut stdin = handle.lock().await;
        stdin
            .write_all(data.as_bytes())
            .await
            .context("writing ssh session input")?;
        stdin.flush().await.context("flushing ssh stdin")?;
        Ok(())
    }

    pub async fn resize(&self, _session_id: &str, _cols: u16, _rows: u16) -> Result<()> {
        Ok(())
    }

    pub async fn close(&self, session_id: &str) -> Result<()> {
        let handle = {
            let mut sessions = self.sessions.lock().await;
            sessions
                .remove(session_id)
                .ok_or_else(|| anyhow!("unknown ssh session: {session_id}"))?
        };

        let mut child = handle.child.lock().await;
        child.kill().await.context("killing ssh session")?;
        Ok(())
    }
}

impl Default for SshSessionManager {
    fn default() -> Self {
        Self::new()
    }
}
