use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use janus_protocol_rdp::{RdpLauncher, RdpSessionManager};
use janus_protocol_ssh::SshSessionManager;
use janus_secrets::VaultManager;
use janus_storage::Storage;

use crate::host_keys::DbHostKeyPolicy;

#[derive(Clone)]
pub struct AppState {
    pub storage: Storage,
    pub vault: VaultManager,
    pub ssh: SshSessionManager,
    pub ssh_host_keys: DbHostKeyPolicy,
    pub rdp: RdpSessionManager,
    pub rdp_launcher: RdpLauncher,
}

impl AppState {
    pub async fn new(base_dir: PathBuf) -> Result<Self> {
        let db_path = base_dir.join("janus.sqlite");
        let vault_path = base_dir.join("vault.enc.json");

        let storage = Storage::new(&db_path).await?;
        let vault = VaultManager::new(&vault_path);
        let ssh_host_keys = DbHostKeyPolicy::new(storage.clone());
        let ssh_host_key_policy = Arc::new(ssh_host_keys.clone());

        Ok(Self {
            storage,
            vault,
            ssh: SshSessionManager::with_host_key_policy(ssh_host_key_policy),
            ssh_host_keys,
            rdp: RdpSessionManager::new(),
            rdp_launcher: RdpLauncher::new(),
        })
    }
}
