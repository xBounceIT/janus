use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::Duration;

use janus_domain::{
    ConnectionNode, ConnectionUpsert, FolderUpsert, ImportMode, ImportReport, ImportScope,
    RdpLaunchOptions, SessionOptions,
};
use janus_import_export::{apply_report, export_mremoteng as export_xml, parse_mremoteng};
use janus_protocol_rdp::{RdpActiveXEvent, RdpSessionConfig};
use janus_protocol_ssh::{
    SftpFileKind, SftpListResult, SftpTransferProgress, SshEvent, SshLaunchConfig,
};
use janus_storage::ResolvedSecretRefs;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::state::AppState;

fn err<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

fn parse_rdp_port(port: i64) -> Result<u16, String> {
    u16::try_from(port).map_err(|_| format!("invalid RDP port: {port}"))
}

fn parse_connection_probe_port(kind: &str, port: i64) -> Result<u16, String> {
    u16::try_from(port).map_err(|_| format!("invalid {kind} port: {port}"))
}

fn parse_rdp_dimension(label: &str, value: Option<i64>) -> Result<Option<u16>, String> {
    match value {
        Some(v) => u16::try_from(v)
            .map(Some)
            .map_err(|_| format!("invalid RDP {label}: {v}")),
        None => Ok(None),
    }
}

fn main_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())
}

#[cfg(windows)]
fn main_window_hwnd(app: &AppHandle) -> Result<isize, String> {
    let window = main_window(app)?;
    window.hwnd().map(|hwnd| hwnd.0 as isize).map_err(err)
}

#[cfg(not(windows))]
fn main_window_hwnd(_app: &AppHandle) -> Result<isize, String> {
    Err("embedded RDP is only supported on Windows".to_string())
}

fn viewport_to_physical(app: &AppHandle, viewport: RdpViewport) -> Result<RdpViewport, String> {
    let window = main_window(app)?;
    let scale_factor = window.scale_factor().map_err(err)?;
    let scale = |value: i32| ((value as f64) * scale_factor).round() as i32;

    Ok(RdpViewport {
        x: scale(viewport.x),
        y: scale(viewport.y),
        width: scale(viewport.width.max(1)).max(1),
        height: scale(viewport.height.max(1)).max(1),
    })
}

fn file_kind_label(kind: SftpFileKind) -> String {
    match kind {
        SftpFileKind::File => "file",
        SftpFileKind::Dir => "dir",
        SftpFileKind::Symlink => "symlink",
        SftpFileKind::Other => "other",
    }
    .to_string()
}

fn local_kind_label(meta: &std::fs::Metadata) -> String {
    let ft = meta.file_type();
    if ft.is_dir() {
        "dir".to_string()
    } else if ft.is_file() {
        "file".to_string()
    } else if ft.is_symlink() {
        "symlink".to_string()
    } else {
        "other".to_string()
    }
}

fn normalize_path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn local_home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(value) = std::env::var_os("USERPROFILE") {
            return Some(PathBuf::from(value));
        }
        let home_drive = std::env::var_os("HOMEDRIVE");
        let home_path = std::env::var_os("HOMEPATH");
        if let (Some(drive), Some(path)) = (home_drive, home_path) {
            let mut joined = PathBuf::from(drive);
            joined.push(path);
            return Some(joined);
        }
    }

    #[cfg(not(windows))]
    {
        if let Some(value) = std::env::var_os("HOME") {
            return Some(PathBuf::from(value));
        }
    }

    None
}

fn local_default_dir() -> Result<PathBuf, String> {
    if let Some(home) = local_home_dir() {
        let desktop = home.join("Desktop");
        if desktop.is_dir() {
            return Ok(desktop);
        }
        return Ok(home);
    }

    std::env::current_dir().map_err(err)
}

fn local_list_impl(path: &str) -> Result<FileListResultDto, String> {
    let requested = if path.trim().is_empty() {
        local_default_dir()?
    } else {
        PathBuf::from(path)
    };

    let cwd = std::fs::canonicalize(&requested).unwrap_or(requested);
    let mut entries = Vec::new();

    let read_dir = std::fs::read_dir(&cwd).map_err(err)?;
    for entry in read_dir {
        let entry = entry.map_err(err)?;
        let path = entry.path();
        let meta = entry.metadata().map_err(err)?;
        let modified_at = meta
            .modified()
            .ok()
            .and_then(|ts| ts.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        let name = entry.file_name().to_string_lossy().to_string();
        let hidden = name.starts_with('.');

        entries.push(FileEntryDto {
            name,
            path: normalize_path_string(&path),
            kind: local_kind_label(&meta),
            size: if meta.is_file() {
                Some(meta.len())
            } else {
                None
            },
            modified_at,
            owner: None,
            permissions: None,
            hidden,
        });
    }

    entries.sort_by(|a, b| {
        let a_dir = a.kind == "dir";
        let b_dir = b.kind == "dir";
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(FileListResultDto {
        cwd: normalize_path_string(&cwd),
        entries,
    })
}

fn sftp_list_to_dto(result: SftpListResult) -> FileListResultDto {
    FileListResultDto {
        cwd: result.cwd,
        entries: result
            .entries
            .into_iter()
            .map(|entry| FileEntryDto {
                hidden: entry.name.starts_with('.'),
                name: entry.name,
                path: entry.path,
                kind: file_kind_label(entry.kind),
                size: entry.size,
                modified_at: entry.modified_time,
                owner: entry.owner,
                permissions: entry.permissions,
            })
            .collect(),
    }
}

fn sftp_transfer_event_name(sftp_session_id: &str) -> String {
    format!("sftp://{sftp_session_id}/transfer")
}

fn emit_sftp_transfer_progress(
    app: &AppHandle,
    sftp_session_id: &str,
    direction: SftpTransferDirectionDto,
    phase: &'static str,
    local_path: &str,
    remote_path: &str,
    progress: SftpTransferProgress,
) {
    let _ = app.emit(
        &sftp_transfer_event_name(sftp_session_id),
        SftpTransferProgressDto {
            direction,
            phase,
            local_path,
            remote_path,
            bytes_transferred: progress.bytes_transferred,
            total_bytes: progress.total_bytes,
        },
    );
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    initialized: bool,
    unlocked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpProbeResult {
    host: String,
    reachable: bool,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SshSessionOpenResult {
    Opened {
        session_id: String,
    },
    HostKeyMismatch {
        token: String,
        host: String,
        port: i64,
        stored_key_type: String,
        stored_fingerprint: String,
        presented_key_type: String,
        presented_fingerprint: String,
        warning: String,
    },
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct RdpViewport {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RdpLifecyclePayload {
    Connecting,
    Connected,
    LoginComplete,
    Disconnected {
        reason: i32,
    },
    FatalError {
        error_code: i32,
    },
    LogonError {
        error_code: i32,
    },
    HostInitFailed {
        stage: String,
        hresult: Option<i32>,
        message: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntryDto {
    name: String,
    path: String,
    kind: String,
    size: Option<u64>,
    modified_at: Option<u64>,
    owner: Option<String>,
    permissions: Option<u32>,
    hidden: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileListResultDto {
    cwd: String,
    entries: Vec<FileEntryDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpSessionOpenDto {
    sftp_session_id: String,
    remote_cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpPathRequest {
    pub ssh_session_id: String,
    pub sftp_session_id: String,
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpRenameRequest {
    pub ssh_session_id: String,
    pub sftp_session_id: String,
    pub old_path: String,
    pub new_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpDeleteRequest {
    pub ssh_session_id: String,
    pub sftp_session_id: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpListRequest {
    pub ssh_session_id: String,
    pub sftp_session_id: String,
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferRequest {
    pub ssh_session_id: String,
    pub sftp_session_id: String,
    pub local_path: String,
    pub remote_path: String,
    pub overwrite: Option<bool>,
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum SftpTransferDirectionDto {
    Upload,
    Download,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SftpTransferProgressDto<'a> {
    direction: SftpTransferDirectionDto,
    phase: &'static str,
    local_path: &'a str,
    remote_path: &'a str,
    bytes_transferred: u64,
    total_bytes: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPathRequest {
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRenameRequest {
    pub old_path: String,
    pub new_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDeleteRequest {
    pub path: String,
    pub is_dir: bool,
}

#[tauri::command]
pub async fn vault_initialize(
    passphrase: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.vault.initialize(&passphrase).await.map_err(err)
}

#[tauri::command]
pub async fn vault_unlock(passphrase: String, state: State<'_, AppState>) -> Result<(), String> {
    state.vault.unlock(&passphrase).await.map_err(err)
}

#[tauri::command]
pub fn vault_lock(state: State<'_, AppState>) -> Result<(), String> {
    state.vault.lock().map_err(err)
}

#[tauri::command]
pub async fn vault_status(state: State<'_, AppState>) -> Result<VaultStatus, String> {
    Ok(VaultStatus {
        initialized: state.vault.is_initialized().await.map_err(err)?,
        unlocked: state.vault.is_unlocked(),
    })
}

#[tauri::command]
pub async fn connection_tree_list(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionNode>, String> {
    state.storage.list_tree().await.map_err(err)
}

#[tauri::command]
pub async fn folder_upsert(folder: FolderUpsert, state: State<'_, AppState>) -> Result<(), String> {
    state.storage.upsert_folder(&folder).await.map_err(err)
}

#[tauri::command]
pub async fn connection_upsert(
    mut connection: ConnectionUpsert,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut refs = ResolvedSecretRefs::default();

    if let Some(ssh) = connection.ssh.as_mut() {
        if let Some(password) = ssh.password.take() {
            let secret = state
                .vault
                .put_secret(janus_domain::SecretKind::Password, &password)
                .await
                .map_err(err)?;
            refs.ssh_password_ref = Some(secret.id);
        }

        if let Some(key_passphrase) = ssh.key_passphrase.take() {
            let secret = state
                .vault
                .put_secret(janus_domain::SecretKind::KeyPassphrase, &key_passphrase)
                .await
                .map_err(err)?;
            refs.ssh_key_passphrase_ref = Some(secret.id);
        }
    }

    if let Some(rdp) = connection.rdp.as_mut() {
        if let Some(password) = rdp.password.take() {
            let secret = state
                .vault
                .put_secret(janus_domain::SecretKind::RdpPassword, &password)
                .await
                .map_err(err)?;
            refs.rdp_password_ref = Some(secret.id);
        }
    }

    state
        .storage
        .upsert_connection(&connection, &refs)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn node_delete(node_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.storage.delete_node(&node_id).await.map_err(err)
}

#[tauri::command]
pub async fn connection_tcp_probe(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<TcpProbeResult, String> {
    let node = state
        .storage
        .get_node(&connection_id)
        .await
        .map_err(err)?
        .ok_or_else(|| "connection not found".to_string())?;

    let (host, port) = if let Some(ssh) = node.ssh {
        (ssh.host, parse_connection_probe_port("SSH", ssh.port)?)
    } else if let Some(rdp) = node.rdp {
        (rdp.host, parse_connection_probe_port("RDP", rdp.port)?)
    } else {
        return Err("connection is not SSH or RDP or missing config".to_string());
    };

    let probe_host = host.clone();
    let reachable =
        tauri::async_runtime::spawn_blocking(move || tcp_socket_probe(&probe_host, port))
            .await
            .map_err(err)??;

    Ok(TcpProbeResult { host, reachable })
}

#[tauri::command]
pub async fn connection_saved_password_get(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let node = state
        .storage
        .get_node(&connection_id)
        .await
        .map_err(err)?
        .ok_or_else(|| "connection not found".to_string())?;

    let secret_ref = if let Some(ssh) = node.ssh.as_ref() {
        ssh.auth_ref.as_deref()
    } else if let Some(rdp) = node.rdp.as_ref() {
        rdp.credential_ref.as_deref()
    } else {
        return Err("connection is not SSH or RDP or missing config".to_string());
    };

    let secret_ref = secret_ref.ok_or_else(|| "no saved password for connection".to_string())?;
    let password = state
        .vault
        .get_secret(secret_ref)
        .map_err(err)?
        .ok_or_else(|| "saved password secret not found".to_string())?;

    if password.is_empty() {
        return Err("no saved password for connection".to_string());
    }

    Ok(password)
}

#[tauri::command]
pub async fn ssh_session_open(
    connection_id: String,
    session_opts: Option<SessionOptions>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SshSessionOpenResult, String> {
    let node = state
        .storage
        .get_node(&connection_id)
        .await
        .map_err(err)?
        .ok_or_else(|| "connection not found".to_string())?;

    let ssh = node
        .ssh
        .ok_or_else(|| "connection is not SSH or missing SSH config".to_string())?;

    let password = match ssh.auth_ref.as_ref() {
        Some(id) => state.vault.get_secret(id).map_err(err)?,
        None => None,
    };
    let key_passphrase = match ssh.key_passphrase_ref.as_ref() {
        Some(id) => state.vault.get_secret(id).map_err(err)?,
        None => None,
    };
    let session_id_hint = session_opts.as_ref().and_then(|o| o.session_id.clone());
    let cols = session_opts
        .as_ref()
        .and_then(|opts| opts.cols)
        .unwrap_or(120);
    let rows = session_opts
        .as_ref()
        .and_then(|opts| opts.rows)
        .unwrap_or(32);

    let config = SshLaunchConfig {
        host: ssh.host,
        port: ssh.port,
        username: ssh.username,
        strict_host_key: ssh.strict_host_key,
        key_path: ssh.key_path,
        key_passphrase,
        password,
        cols,
        rows,
    };

    let (session_id, mut events) = match state.ssh.open_session(&config, session_id_hint).await {
        Ok(result) => result,
        Err(error) => {
            if let Some(mismatch) = state
                .ssh_host_keys
                .pending_mismatch_for_host_port(&config.host, config.port)
                .await
            {
                return Ok(SshSessionOpenResult::HostKeyMismatch {
                    token: mismatch.token,
                    host: mismatch.host.clone(),
                    port: mismatch.port,
                    stored_key_type: mismatch.stored_key_type,
                    stored_fingerprint: mismatch.stored_fingerprint,
                    presented_key_type: mismatch.presented_key_type,
                    presented_fingerprint: mismatch.presented_fingerprint,
                    warning: format!(
                        "Host key for {}:{} has changed. This may indicate a man-in-the-middle attack or a legitimate server key rotation.",
                        mismatch.host, mismatch.port
                    ),
                });
            }
            return Err(err(error));
        }
    };
    let stdout_event = format!("ssh://{session_id}/stdout");
    let exit_event = format!("ssh://{session_id}/exit");

    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                SshEvent::Stdout(chunk) => {
                    let _ = app.emit(&stdout_event, chunk);
                }
                SshEvent::Exit(code) => {
                    let _ = app.emit(&exit_event, code);
                }
            }
        }
    });

    Ok(SshSessionOpenResult::Opened { session_id })
}

fn tcp_socket_probe(host: &str, port: u16) -> Result<bool, String> {
    let timeout = Duration::from_millis(1_000);
    let mut addrs = (host, port).to_socket_addrs().map_err(err)?;

    for addr in addrs.by_ref() {
        if TcpStream::connect_timeout(&addr, timeout).is_ok() {
            return Ok(true);
        }
    }

    Ok(false)
}

#[tauri::command]
pub async fn ssh_host_key_update_from_mismatch(
    connection_id: String,
    token: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let node = state
        .storage
        .get_node(&connection_id)
        .await
        .map_err(err)?
        .ok_or_else(|| "connection not found".to_string())?;

    let ssh = node
        .ssh
        .ok_or_else(|| "connection is not SSH or missing SSH config".to_string())?;

    state
        .ssh_host_keys
        .apply_pending_mismatch(&token, &ssh.host, ssh.port)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn ssh_session_write(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.ssh.write(&session_id, &data).await.map_err(err)
}

#[tauri::command]
pub async fn ssh_session_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.ssh.resize(&session_id, cols, rows).await.map_err(err)
}

#[tauri::command]
pub async fn ssh_session_close(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.ssh.close(&session_id).await.map_err(err)
}

#[tauri::command]
pub async fn ssh_sftp_open(
    ssh_session_id: String,
    state: State<'_, AppState>,
) -> Result<SftpSessionOpenDto, String> {
    let (sftp_session_id, remote_cwd) = state.ssh.sftp_open(&ssh_session_id).await.map_err(err)?;
    Ok(SftpSessionOpenDto {
        sftp_session_id,
        remote_cwd,
    })
}

#[tauri::command]
pub async fn ssh_sftp_close(
    ssh_session_id: String,
    sftp_session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .ssh
        .sftp_close(&ssh_session_id, &sftp_session_id)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn ssh_sftp_list(
    request: SftpListRequest,
    state: State<'_, AppState>,
) -> Result<FileListResultDto, String> {
    let list = state
        .ssh
        .sftp_list(
            &request.ssh_session_id,
            &request.sftp_session_id,
            &request.path,
        )
        .await
        .map_err(err)?;
    Ok(sftp_list_to_dto(list))
}

#[tauri::command]
pub async fn ssh_sftp_new_file(
    request: SftpPathRequest,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .ssh
        .sftp_new_file(
            &request.ssh_session_id,
            &request.sftp_session_id,
            &request.path,
        )
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn ssh_sftp_new_folder(
    request: SftpPathRequest,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .ssh
        .sftp_new_folder(
            &request.ssh_session_id,
            &request.sftp_session_id,
            &request.path,
        )
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn ssh_sftp_rename(
    request: SftpRenameRequest,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .ssh
        .sftp_rename(
            &request.ssh_session_id,
            &request.sftp_session_id,
            &request.old_path,
            &request.new_path,
        )
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn ssh_sftp_delete(
    request: SftpDeleteRequest,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .ssh
        .sftp_delete(
            &request.ssh_session_id,
            &request.sftp_session_id,
            &request.path,
            request.is_dir,
        )
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn ssh_sftp_upload_file(
    request: SftpTransferRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut started = false;
    let mut last_progress = SftpTransferProgress {
        bytes_transferred: 0,
        total_bytes: None,
    };

    let result = state
        .ssh
        .sftp_upload_file_with_progress(
            &request.ssh_session_id,
            &request.sftp_session_id,
            Path::new(&request.local_path),
            &request.remote_path,
            request.overwrite.unwrap_or(false),
            |progress| {
                let phase = if started { "progress" } else { "start" };
                started = true;
                last_progress = progress;
                emit_sftp_transfer_progress(
                    &app,
                    &request.sftp_session_id,
                    SftpTransferDirectionDto::Upload,
                    phase,
                    &request.local_path,
                    &request.remote_path,
                    progress,
                );
            },
        )
        .await
        .map_err(err);

    if result.is_ok() {
        emit_sftp_transfer_progress(
            &app,
            &request.sftp_session_id,
            SftpTransferDirectionDto::Upload,
            "complete",
            &request.local_path,
            &request.remote_path,
            last_progress,
        );
    }

    result
}

#[tauri::command]
pub async fn ssh_sftp_download_file(
    request: SftpTransferRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut started = false;
    let mut last_progress = SftpTransferProgress {
        bytes_transferred: 0,
        total_bytes: None,
    };

    let result = state
        .ssh
        .sftp_download_file_with_progress(
            &request.ssh_session_id,
            &request.sftp_session_id,
            &request.remote_path,
            Path::new(&request.local_path),
            request.overwrite.unwrap_or(false),
            |progress| {
                let phase = if started { "progress" } else { "start" };
                started = true;
                last_progress = progress;
                emit_sftp_transfer_progress(
                    &app,
                    &request.sftp_session_id,
                    SftpTransferDirectionDto::Download,
                    phase,
                    &request.local_path,
                    &request.remote_path,
                    progress,
                );
            },
        )
        .await
        .map_err(err);

    if result.is_ok() {
        emit_sftp_transfer_progress(
            &app,
            &request.sftp_session_id,
            SftpTransferDirectionDto::Download,
            "complete",
            &request.local_path,
            &request.remote_path,
            last_progress,
        );
    }

    result
}

#[tauri::command]
pub async fn local_fs_list(path: String) -> Result<FileListResultDto, String> {
    tauri::async_runtime::spawn_blocking(move || local_list_impl(&path))
        .await
        .map_err(err)?
}

#[tauri::command]
pub async fn local_fs_new_file(request: LocalPathRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(request.path);
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(err)?;
            }
        }
        std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(err)?;
        Ok(())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn local_fs_new_folder(request: LocalPathRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir(PathBuf::from(request.path)).map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn local_fs_rename(request: LocalRenameRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::rename(request.old_path, request.new_path).map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn local_fs_delete(request: LocalDeleteRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(request.path);
        if request.is_dir {
            std::fs::remove_dir(path).map_err(err)
        } else {
            std::fs::remove_file(path).map_err(err)
        }
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn rdp_launch(
    _connection_id: String,
    _launch_opts: Option<RdpLaunchOptions>,
    _state: State<'_, AppState>,
) -> Result<(), String> {
    Err("rdp_launch is deprecated; use rdp_session_open".to_string())
}

#[tauri::command]
pub async fn rdp_session_open(
    connection_id: String,
    viewport: RdpViewport,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let node = state
        .storage
        .get_node(&connection_id)
        .await
        .map_err(err)?
        .ok_or_else(|| "connection not found".to_string())?;

    let rdp = node
        .rdp
        .ok_or_else(|| "connection is not RDP or missing RDP config".to_string())?;

    let password = match rdp.credential_ref.as_ref() {
        Some(id) => state.vault.get_secret(id).map_err(err)?,
        None => None,
    };

    let session_id = Uuid::new_v4().to_string();
    let parent_hwnd = main_window_hwnd(&app)?;
    let viewport = viewport_to_physical(&app, viewport)?;
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
    let lifecycle_event = format!("rdp://{session_id}/state");
    let exit_event = format!("rdp://{session_id}/exit");
    let app_for_events = app.clone();

    let config = RdpSessionConfig {
        host: rdp.host,
        port: parse_rdp_port(rdp.port)?,
        username: rdp.username,
        password,
        domain: rdp.domain,
        width: parse_rdp_dimension("width", rdp.width)?,
        height: parse_rdp_dimension("height", rdp.height)?,
    };

    tauri::async_runtime::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            match event {
                RdpActiveXEvent::Connecting { .. } => {
                    let _ = app_for_events.emit(&lifecycle_event, RdpLifecyclePayload::Connecting);
                }
                RdpActiveXEvent::Connected { .. } => {
                    let _ = app_for_events.emit(&lifecycle_event, RdpLifecyclePayload::Connected);
                }
                RdpActiveXEvent::LoginComplete { .. } => {
                    let _ =
                        app_for_events.emit(&lifecycle_event, RdpLifecyclePayload::LoginComplete);
                }
                RdpActiveXEvent::Disconnected { reason, .. } => {
                    let _ = app_for_events.emit(
                        &lifecycle_event,
                        RdpLifecyclePayload::Disconnected { reason },
                    );
                    let _ = app_for_events.emit(&exit_event, reason.to_string());
                    break;
                }
                RdpActiveXEvent::FatalError { error_code, .. } => {
                    let _ = app_for_events.emit(
                        &lifecycle_event,
                        RdpLifecyclePayload::FatalError { error_code },
                    );
                    let _ = app_for_events.emit(&exit_event, format!("fatal:{error_code}"));
                    break;
                }
                RdpActiveXEvent::LogonError { error_code, .. } => {
                    let _ = app_for_events.emit(
                        &lifecycle_event,
                        RdpLifecyclePayload::LogonError { error_code },
                    );
                }
                RdpActiveXEvent::HostInitFailed {
                    stage,
                    hresult,
                    message,
                    ..
                } => {
                    let _ = app_for_events.emit(
                        &lifecycle_event,
                        RdpLifecyclePayload::HostInitFailed {
                            stage,
                            hresult,
                            message,
                        },
                    );
                    let _ = app_for_events.emit(&exit_event, "host-init-failed");
                    break;
                }
            }
        }
    });

    state
        .rdp
        .create_session(&session_id, parent_hwnd, &config, event_tx)
        .await
        .map_err(err)?;
    state
        .rdp
        .reposition(
            &session_id,
            viewport.x,
            viewport.y,
            viewport.width,
            viewport.height,
        )
        .map_err(err)?;
    state.rdp.show(&session_id).map_err(err)?;

    Ok(session_id)
}

#[tauri::command]
pub async fn rdp_session_close(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.rdp.close(&session_id).await.map_err(err)
}

#[tauri::command]
pub async fn rdp_session_set_bounds(
    session_id: String,
    viewport: RdpViewport,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let viewport = viewport_to_physical(&app, viewport)?;
    state
        .rdp
        .reposition(
            &session_id,
            viewport.x,
            viewport.y,
            viewport.width,
            viewport.height,
        )
        .map_err(err)
}

#[tauri::command]
pub async fn rdp_session_show(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.rdp.show(&session_id).map_err(err)
}

#[tauri::command]
pub async fn rdp_session_hide(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.rdp.hide(&session_id).map_err(err)
}

#[tauri::command]
pub async fn import_mremoteng(
    path: String,
    mode: ImportMode,
    state: State<'_, AppState>,
) -> Result<ImportReport, String> {
    let parsed = parse_mremoteng(Path::new(&path)).map_err(err)?;

    let created_estimate = parsed.folders.len() + parsed.connections.len();
    if matches!(mode, ImportMode::DryRun) {
        return Ok(apply_report(
            &parsed,
            created_estimate,
            0,
            parsed.warnings.len(),
        ));
    }

    let mut created = 0;
    for folder in &parsed.folders {
        state.storage.upsert_folder(folder).await.map_err(err)?;
        created += 1;
    }

    let refs = ResolvedSecretRefs::default();
    for connection in &parsed.connections {
        state
            .storage
            .upsert_connection(connection, &refs)
            .await
            .map_err(err)?;
        created += 1;
    }

    Ok(apply_report(&parsed, created, 0, parsed.warnings.len()))
}

#[tauri::command]
pub async fn export_mremoteng(
    path: String,
    _scope: Option<ImportScope>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let nodes = state.storage.list_tree().await.map_err(err)?;
    export_xml(Path::new(&path), &nodes).map_err(err)
}
