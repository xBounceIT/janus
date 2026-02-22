use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use russh::client;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::{ChannelMsg, Disconnect};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileType as SftpProtocolFileType;
use tokio::fs::File as TokioFile;
use tokio::io::{AsyncWriteExt, copy};
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SftpFileKind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Debug, Clone)]
pub struct SftpFileEntry {
    pub name: String,
    pub path: String,
    pub kind: SftpFileKind,
    pub size: Option<u64>,
    pub modified_time: Option<u64>,
    pub permissions: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct SftpListResult {
    pub cwd: String,
    pub entries: Vec<SftpFileEntry>,
}

enum SessionCommand {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshHostKey {
    pub key_type: String,
    pub public_key: String,
    pub sha256_fingerprint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyDecision {
    Accept,
    Reject,
}

pub struct HostKeyCheck<'a> {
    pub host: &'a str,
    pub port: u16,
    pub strict_host_key: bool,
    pub server_key: &'a SshHostKey,
}

#[async_trait::async_trait]
pub trait HostKeyPolicy: Send + Sync {
    async fn check_host_key(&self, check: HostKeyCheck<'_>) -> Result<HostKeyDecision>;
}

#[derive(Default)]
struct PermissiveHostKeyPolicy;

#[async_trait::async_trait]
impl HostKeyPolicy for PermissiveHostKeyPolicy {
    async fn check_host_key(&self, _check: HostKeyCheck<'_>) -> Result<HostKeyDecision> {
        Ok(HostKeyDecision::Accept)
    }
}

struct ClientHandler {
    host: String,
    port: u16,
    strict_host_key: bool,
    host_key_policy: Arc<dyn HostKeyPolicy>,
}

#[async_trait::async_trait]
impl client::Handler for ClientHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh_keys::ssh_key::PublicKey,
    ) -> Result<bool> {
        let public_key = server_public_key
            .to_openssh()
            .context("failed to serialize server public key")?;
        let key_type = server_public_key.algorithm().to_string();
        let sha256_fingerprint = server_public_key
            .fingerprint(russh_keys::ssh_key::HashAlg::Sha256)
            .to_string();

        let server_key = SshHostKey {
            key_type,
            public_key,
            sha256_fingerprint,
        };

        let decision = self
            .host_key_policy
            .check_host_key(HostKeyCheck {
                host: &self.host,
                port: self.port,
                strict_host_key: self.strict_host_key,
                server_key: &server_key,
            })
            .await?;

        Ok(matches!(decision, HostKeyDecision::Accept))
    }
}

type SharedSshHandle = Arc<Mutex<client::Handle<ClientHandler>>>;
type SharedSftpSession = Arc<Mutex<SftpSession>>;

#[derive(Clone)]
pub struct SshSessionManager {
    sessions: Arc<Mutex<HashMap<String, SessionHandle>>>,
    host_key_policy: Arc<dyn HostKeyPolicy>,
}

struct SessionHandle {
    cmd_tx: mpsc::UnboundedSender<SessionCommand>,
    task_handle: tokio::task::JoinHandle<()>,
    ssh_handle: SharedSshHandle,
    sftp_sessions: Arc<Mutex<HashMap<String, SharedSftpSession>>>,
}

impl SshSessionManager {
    pub fn new() -> Self {
        Self::with_host_key_policy(Arc::new(PermissiveHostKeyPolicy))
    }

    pub fn with_host_key_policy(host_key_policy: Arc<dyn HostKeyPolicy>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            host_key_policy,
        }
    }

    pub async fn open_session(
        &self,
        config: &SshLaunchConfig,
        session_id_hint: Option<String>,
    ) -> Result<(String, mpsc::UnboundedReceiver<SshEvent>)> {
        let ssh_config = client::Config::default();

        let handler = ClientHandler {
            host: config.host.clone(),
            port: config.port as u16,
            strict_host_key: config.strict_host_key,
            host_key_policy: Arc::clone(&self.host_key_policy),
        };

        let (ssh_handle_raw, mut channel) = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            async {
                let mut session = client::connect(
                    Arc::new(ssh_config),
                    (config.host.as_str(), config.port as u16),
                    handler,
                )
                .await
                .context("SSH connection failed")?;

                let mut authenticated = false;

                if let Some(key_path) = &config.key_path {
                    let passphrase = config.key_passphrase.as_deref();
                    match russh_keys::load_secret_key(key_path, passphrase) {
                        Ok(key_pair) => {
                            let key = PrivateKeyWithHashAlg::new(Arc::new(key_pair), None)
                                .context("failed to prepare key for auth")?;
                            match session.authenticate_publickey(&config.username, key).await {
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

                let channel = session
                    .channel_open_session()
                    .await
                    .context("failed to open SSH channel")?;

                channel
                    .request_pty(
                        true,
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
                    .request_shell(true)
                    .await
                    .context("failed to request shell")?;

                Ok::<_, anyhow::Error>((session, channel))
            },
        )
        .await
        .map_err(|_| anyhow!("SSH open timed out after 10s during connect/auth/channel setup"))??;

        let ssh_handle = Arc::new(Mutex::new(ssh_handle_raw));
        let sftp_sessions = Arc::new(Mutex::new(HashMap::new()));

        let session_id = session_id_hint.unwrap_or_else(|| Uuid::new_v4().to_string());
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
                ssh_handle,
                sftp_sessions,
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

    pub async fn sftp_open(&self, session_id: &str) -> Result<(String, String)> {
        let (ssh_handle, sftp_map) = self.session_shared_handles(session_id).await?;

        let ssh = ssh_handle.lock().await;
        let channel = ssh
            .channel_open_session()
            .await
            .context("failed to open SSH channel for SFTP")?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .context("failed to request sftp subsystem")?;
        drop(ssh);

        let sftp = SftpSession::new(channel.into_stream())
            .await
            .context("failed to initialize sftp session")?;
        let initial_cwd = match sftp.canonicalize(".").await {
            Ok(path) => path,
            Err(_) => ".".to_string(),
        };

        let sftp_session_id = Uuid::new_v4().to_string();
        sftp_map
            .lock()
            .await
            .insert(sftp_session_id.clone(), Arc::new(Mutex::new(sftp)));

        Ok((sftp_session_id, initial_cwd))
    }

    pub async fn sftp_close(&self, session_id: &str, sftp_session_id: &str) -> Result<()> {
        let sftp = {
            let (_ssh_handle, sftp_map) = self.session_shared_handles(session_id).await?;
            let mut map = sftp_map.lock().await;
            map.remove(sftp_session_id)
                .ok_or_else(|| anyhow!("unknown sftp session: {sftp_session_id}"))?
        };

        let sftp = sftp.lock().await;
        sftp.close().await.map_err(|e| anyhow!(e.to_string()))
    }

    pub async fn sftp_list(
        &self,
        session_id: &str,
        sftp_session_id: &str,
        path: &str,
    ) -> Result<SftpListResult> {
        let sftp = self.get_sftp_session(session_id, sftp_session_id).await?;
        let sftp = sftp.lock().await;

        let requested = if path.trim().is_empty() { "." } else { path };
        let cwd = match sftp.canonicalize(requested).await {
            Ok(path) => path,
            Err(_) => requested.to_string(),
        };

        let read_dir = sftp
            .read_dir(cwd.clone())
            .await
            .map_err(|e| anyhow!(e.to_string()))?;

        let mut entries = read_dir
            .map(|entry| {
                let name = entry.file_name();
                let metadata = entry.metadata();
                let kind = match entry.file_type() {
                    SftpProtocolFileType::Dir => SftpFileKind::Dir,
                    SftpProtocolFileType::File => SftpFileKind::File,
                    SftpProtocolFileType::Symlink => SftpFileKind::Symlink,
                    SftpProtocolFileType::Other => SftpFileKind::Other,
                };
                SftpFileEntry {
                    path: remote_join(&cwd, &name),
                    name,
                    kind,
                    size: metadata.size,
                    modified_time: metadata.mtime.map(|v| v as u64),
                    permissions: metadata.permissions,
                }
            })
            .collect::<Vec<_>>();

        entries.sort_by(|a, b| {
            let a_dir = matches!(a.kind, SftpFileKind::Dir);
            let b_dir = matches!(b.kind, SftpFileKind::Dir);
            b_dir.cmp(&a_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(SftpListResult { cwd, entries })
    }

    pub async fn sftp_new_file(
        &self,
        session_id: &str,
        sftp_session_id: &str,
        path: &str,
    ) -> Result<()> {
        let sftp = self.get_sftp_session(session_id, sftp_session_id).await?;
        let sftp = sftp.lock().await;
        let _file = sftp.create(path).await.map_err(|e| anyhow!(e.to_string()))?;
        Ok(())
    }

    pub async fn sftp_new_folder(
        &self,
        session_id: &str,
        sftp_session_id: &str,
        path: &str,
    ) -> Result<()> {
        let sftp = self.get_sftp_session(session_id, sftp_session_id).await?;
        let sftp = sftp.lock().await;
        sftp.create_dir(path).await.map_err(|e| anyhow!(e.to_string()))
    }

    pub async fn sftp_rename(
        &self,
        session_id: &str,
        sftp_session_id: &str,
        old_path: &str,
        new_path: &str,
    ) -> Result<()> {
        let sftp = self.get_sftp_session(session_id, sftp_session_id).await?;
        let sftp = sftp.lock().await;
        sftp.rename(old_path, new_path)
            .await
            .map_err(|e| anyhow!(e.to_string()))
    }

    pub async fn sftp_delete(
        &self,
        session_id: &str,
        sftp_session_id: &str,
        path: &str,
        is_dir: bool,
    ) -> Result<()> {
        let sftp = self.get_sftp_session(session_id, sftp_session_id).await?;
        let sftp = sftp.lock().await;
        if is_dir {
            sftp.remove_dir(path).await.map_err(|e| anyhow!(e.to_string()))
        } else {
            sftp.remove_file(path).await.map_err(|e| anyhow!(e.to_string()))
        }
    }

    pub async fn sftp_upload_file(
        &self,
        session_id: &str,
        sftp_session_id: &str,
        local_path: &Path,
        remote_path: &str,
        overwrite: bool,
    ) -> Result<()> {
        let sftp = self.get_sftp_session(session_id, sftp_session_id).await?;
        let sftp = sftp.lock().await;

        if !overwrite && sftp.try_exists(remote_path).await.map_err(|e| anyhow!(e.to_string()))? {
            return Err(anyhow!("remote file already exists"));
        }

        let mut src = TokioFile::open(local_path)
            .await
            .with_context(|| format!("opening local file {}", local_path.display()))?;
        let mut dst = sftp
            .create(remote_path)
            .await
            .map_err(|e| anyhow!(e.to_string()))?;

        copy(&mut src, &mut dst)
            .await
            .context("upload copy failed")?;
        let _ = dst.shutdown().await;
        Ok(())
    }

    pub async fn sftp_download_file(
        &self,
        session_id: &str,
        sftp_session_id: &str,
        remote_path: &str,
        local_path: &Path,
        overwrite: bool,
    ) -> Result<()> {
        let sftp = self.get_sftp_session(session_id, sftp_session_id).await?;
        let sftp = sftp.lock().await;

        if !overwrite && tokio::fs::try_exists(local_path).await.unwrap_or(false) {
            return Err(anyhow!("local file already exists"));
        }

        let mut src = sftp
            .open(remote_path)
            .await
            .map_err(|e| anyhow!(e.to_string()))?;
        let mut dst = TokioFile::create(local_path)
            .await
            .with_context(|| format!("creating local file {}", local_path.display()))?;

        copy(&mut src, &mut dst)
            .await
            .context("download copy failed")?;
        dst.flush().await.context("flush downloaded file")?;
        Ok(())
    }

    pub async fn close(&self, session_id: &str) -> Result<()> {
        let handle = {
            let mut sessions = self.sessions.lock().await;
            sessions
                .remove(session_id)
                .ok_or_else(|| anyhow!("unknown ssh session: {session_id}"))?
        };

        let _ = handle.cmd_tx.send(SessionCommand::Close);

        let task = handle.task_handle;
        if tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .is_err()
        {
            tracing::debug!("ssh session task did not exit within 2s, aborting");
        }

        let sftp_sessions = {
            let mut sftp_map = handle.sftp_sessions.lock().await;
            sftp_map.drain().map(|(_, sftp)| sftp).collect::<Vec<_>>()
        };
        for sftp in sftp_sessions {
            let sftp = sftp.lock().await;
            let _ = sftp.close().await;
        }

        let ssh = handle.ssh_handle.lock().await;
        let _ = ssh
            .disconnect(Disconnect::ByApplication, "janus session closed", "en")
            .await;

        Ok(())
    }

    async fn session_shared_handles(
        &self,
        session_id: &str,
    ) -> Result<(SharedSshHandle, Arc<Mutex<HashMap<String, SharedSftpSession>>>)> {
        let sessions = self.sessions.lock().await;
        let handle = sessions
            .get(session_id)
            .ok_or_else(|| anyhow!("unknown ssh session: {session_id}"))?;
        Ok((handle.ssh_handle.clone(), handle.sftp_sessions.clone()))
    }

    async fn get_sftp_session(
        &self,
        session_id: &str,
        sftp_session_id: &str,
    ) -> Result<SharedSftpSession> {
        let (_ssh_handle, sftp_map) = self.session_shared_handles(session_id).await?;
        let map = sftp_map.lock().await;
        map.get(sftp_session_id)
            .cloned()
            .ok_or_else(|| anyhow!("unknown sftp session: {sftp_session_id}"))
    }
}

fn remote_join(base: &str, name: &str) -> String {
    if base == "/" {
        format!("/{name}")
    } else if base.ends_with('/') {
        format!("{base}{name}")
    } else {
        format!("{base}/{name}")
    }
}

impl Default for SshSessionManager {
    fn default() -> Self {
        Self::new()
    }
}
