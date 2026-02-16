use std::path::PathBuf;

use anyhow::Result;
use janus_protocol_rdp::RdpLauncher;
use janus_protocol_ssh::SshSessionManager;
use janus_secrets::VaultManager;
use janus_storage::Storage;

#[derive(Clone)]
pub struct AppState {
    pub storage: Storage,
    pub vault: VaultManager,
    pub ssh: SshSessionManager,
    pub rdp: RdpLauncher,
}

impl AppState {
    pub async fn new(base_dir: PathBuf) -> Result<Self> {
        let db_path = base_dir.join("janus.sqlite");
        let vault_path = base_dir.join("vault.enc.json");

        let storage = Storage::new(&db_path).await?;
        let vault = VaultManager::new(&vault_path);

        Ok(Self {
            storage,
            vault,
            ssh: SshSessionManager::new(),
            rdp: RdpLauncher::new(),
        })
    }
}
