use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use argon2::Argon2;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use chrono::{DateTime, Utc};
use janus_domain::{SecretKind, SecretRef};
use rand::rngs::SysRng;
use rand::TryRng;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroize;

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;

#[derive(Clone)]
pub struct VaultManager {
    file_path: PathBuf,
    state: std::sync::Arc<Mutex<VaultState>>,
}

struct VaultState {
    unlocked: Option<UnlockedVault>,
}

struct UnlockedVault {
    key: [u8; 32],
    salt: [u8; SALT_LEN],
    data: HashMap<String, StoredSecret>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSecret {
    kind: SecretKind,
    value: String,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VaultEnvelope {
    version: u8,
    salt: String,
    nonce: String,
    ciphertext: String,
}

impl VaultManager {
    pub fn new(file_path: &Path) -> Self {
        Self {
            file_path: file_path.to_path_buf(),
            state: std::sync::Arc::new(Mutex::new(VaultState { unlocked: None })),
        }
    }

    pub async fn initialize(&self, passphrase: &str) -> Result<()> {
        if passphrase.is_empty() {
            return Err(anyhow!("passphrase cannot be empty"));
        }

        if tokio::fs::try_exists(&self.file_path)
            .await
            .context("checking vault file existence")?
        {
            return Err(anyhow!("vault already initialized"));
        }

        if let Some(parent) = self.file_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("creating vault directory {}", parent.display()))?;
        }

        let mut salt = [0_u8; SALT_LEN];
        SysRng
            .try_fill_bytes(&mut salt)
            .map_err(|err| anyhow!("filling vault salt from OS RNG failed: {err}"))?;
        let key = derive_key(passphrase, &salt)?;
        let payload = serde_json::to_vec(&HashMap::<String, StoredSecret>::new())
            .context("encoding initial vault payload")?;
        let envelope = encrypt_payload(&key, &salt, &payload)?;

        tokio::fs::write(&self.file_path, serde_json::to_vec_pretty(&envelope)?)
            .await
            .context("writing initial vault envelope")?;

        Ok(())
    }

    pub async fn unlock(&self, passphrase: &str) -> Result<()> {
        if passphrase.is_empty() {
            return Err(anyhow!("passphrase cannot be empty"));
        }

        let bytes = tokio::fs::read(&self.file_path)
            .await
            .with_context(|| format!("reading vault file {}", self.file_path.display()))?;

        let envelope: VaultEnvelope =
            serde_json::from_slice(&bytes).context("parsing vault envelope")?;

        let salt_bytes = base64::engine::general_purpose::STANDARD
            .decode(&envelope.salt)
            .context("decoding vault salt")?;
        if salt_bytes.len() != SALT_LEN {
            return Err(anyhow!("invalid salt length in vault"));
        }

        let mut salt = [0_u8; SALT_LEN];
        salt.copy_from_slice(&salt_bytes);

        let key = derive_key(passphrase, &salt)?;
        let decrypted = decrypt_payload(&key, &envelope)?;
        let data: HashMap<String, StoredSecret> =
            serde_json::from_slice(&decrypted).context("decoding vault payload")?;

        let mut guard = self
            .state
            .lock()
            .map_err(|_| anyhow!("vault mutex poisoned"))?;

        if let Some(mut unlocked) = guard.unlocked.take() {
            unlocked.key.zeroize();
        }

        guard.unlocked = Some(UnlockedVault { key, salt, data });
        Ok(())
    }

    pub fn lock(&self) -> Result<()> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| anyhow!("vault mutex poisoned"))?;

        if let Some(mut unlocked) = guard.unlocked.take() {
            unlocked.key.zeroize();
        }

        Ok(())
    }

    pub async fn put_secret(&self, kind: SecretKind, value: &str) -> Result<SecretRef> {
        let (serialized, mut key, salt, secret_ref) = {
            let mut guard = self
                .state
                .lock()
                .map_err(|_| anyhow!("vault mutex poisoned"))?;

            let unlocked = guard
                .unlocked
                .as_mut()
                .ok_or_else(|| anyhow!("vault is locked"))?;

            let id = Uuid::new_v4().to_string();
            let created_at = Utc::now();

            unlocked.data.insert(
                id.clone(),
                StoredSecret {
                    kind: kind.clone(),
                    value: value.to_string(),
                    created_at,
                },
            );

            (
                serde_json::to_vec(&unlocked.data).context("serializing vault map")?,
                unlocked.key,
                unlocked.salt,
                SecretRef {
                    id,
                    kind,
                    created_at,
                },
            )
        };

        let envelope = encrypt_payload(&key, &salt, &serialized)?;
        tokio::fs::write(&self.file_path, serde_json::to_vec_pretty(&envelope)?)
            .await
            .with_context(|| format!("writing vault file {}", self.file_path.display()))?;
        key.zeroize();

        Ok(secret_ref)
    }

    pub fn get_secret(&self, id: &str) -> Result<Option<String>> {
        let guard = self
            .state
            .lock()
            .map_err(|_| anyhow!("vault mutex poisoned"))?;

        let unlocked = guard
            .unlocked
            .as_ref()
            .ok_or_else(|| anyhow!("vault is locked"))?;

        Ok(unlocked.data.get(id).map(|record| record.value.clone()))
    }

    pub fn is_unlocked(&self) -> bool {
        self.state
            .lock()
            .map(|guard| guard.unlocked.is_some())
            .unwrap_or(false)
    }

    pub async fn is_initialized(&self) -> Result<bool> {
        tokio::fs::try_exists(&self.file_path)
            .await
            .context("checking vault file existence")
    }
}

fn derive_key(passphrase: &str, salt: &[u8; SALT_LEN]) -> Result<[u8; 32]> {
    let mut key = [0_u8; 32];
    Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|err| anyhow!("deriving vault key failed: {err}"))?;
    Ok(key)
}

fn encrypt_payload(key: &[u8; 32], salt: &[u8; SALT_LEN], payload: &[u8]) -> Result<VaultEnvelope> {
    let cipher = XChaCha20Poly1305::new(key.into());

    let mut nonce = [0_u8; NONCE_LEN];
    SysRng
        .try_fill_bytes(&mut nonce)
        .map_err(|err| anyhow!("filling vault nonce from OS RNG failed: {err}"))?;

    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), payload)
        .map_err(|_| anyhow!("encrypting vault payload failed"))?;

    Ok(VaultEnvelope {
        version: 1,
        salt: base64::engine::general_purpose::STANDARD.encode(salt),
        nonce: base64::engine::general_purpose::STANDARD.encode(nonce),
        ciphertext: base64::engine::general_purpose::STANDARD.encode(ciphertext),
    })
}

fn decrypt_payload(key: &[u8; 32], envelope: &VaultEnvelope) -> Result<Vec<u8>> {
    let nonce = base64::engine::general_purpose::STANDARD
        .decode(&envelope.nonce)
        .context("decoding vault nonce")?;
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(&envelope.ciphertext)
        .context("decoding vault ciphertext")?;

    if nonce.len() != NONCE_LEN {
        return Err(anyhow!("invalid vault nonce length"));
    }

    let cipher = XChaCha20Poly1305::new(key.into());
    let plaintext = cipher
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| anyhow!("invalid passphrase or corrupted vault"))?;

    Ok(plaintext)
}
