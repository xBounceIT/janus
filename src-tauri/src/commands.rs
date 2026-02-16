use std::path::Path;

use janus_domain::{
    ConnectionNode, ConnectionUpsert, FolderUpsert, ImportMode, ImportReport, ImportScope, RdpLaunchOptions,
    SessionOptions,
};
use janus_import_export::{apply_report, export_mremoteng as export_xml, parse_mremoteng};
use janus_protocol_rdp::RdpLaunchConfig;
use janus_protocol_ssh::{SshEvent, SshLaunchConfig};
use janus_storage::ResolvedSecretRefs;
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;

fn err<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

#[tauri::command]
pub async fn vault_initialize(passphrase: String, state: State<'_, AppState>) -> Result<(), String> {
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
pub async fn connection_tree_list(state: State<'_, AppState>) -> Result<Vec<ConnectionNode>, String> {
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
pub async fn ssh_session_open(
    connection_id: String,
    _session_opts: Option<SessionOptions>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
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

    let config = SshLaunchConfig {
        host: ssh.host,
        port: ssh.port,
        username: ssh.username,
        strict_host_key: ssh.strict_host_key,
        key_path: ssh.key_path,
        password,
    };

    let (session_id, mut events) = state.ssh.open_session(&config).await.map_err(err)?;
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

    Ok(session_id)
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
pub async fn ssh_session_close(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.ssh.close(&session_id).await.map_err(err)
}

#[tauri::command]
pub async fn rdp_launch(
    connection_id: String,
    _launch_opts: Option<RdpLaunchOptions>,
    state: State<'_, AppState>,
) -> Result<(), String> {
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

    state
        .rdp
        .launch(&RdpLaunchConfig {
            host: rdp.host,
            port: rdp.port,
            username: rdp.username,
            domain: rdp.domain,
            screen_mode: rdp.screen_mode,
            width: rdp.width,
            height: rdp.height,
            password,
        })
        .await
        .map_err(err)?;

    Ok(())
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
        return Ok(apply_report(&parsed, created_estimate, 0, parsed.warnings.len()));
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
