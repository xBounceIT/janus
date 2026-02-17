use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
#[cfg(test)]
use janus_protocol_ssh::SshHostKey;
use janus_protocol_ssh::{HostKeyCheck, HostKeyDecision, HostKeyPolicy};
use janus_storage::Storage;
use uuid::Uuid;

const PENDING_MISMATCH_TTL: Duration = Duration::from_secs(10 * 60);
const PENDING_MISMATCH_OPEN_WINDOW: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
pub struct PendingHostKeyMismatch {
    pub token: String,
    pub host: String,
    pub port: i64,
    pub stored_key_type: String,
    pub stored_fingerprint: String,
    pub presented_key_type: String,
    pub presented_fingerprint: String,
    pub presented_public_key: String,
    created_at: Instant,
}

#[derive(Debug, Default)]
struct PendingMismatchStore {
    by_token: HashMap<String, PendingHostKeyMismatch>,
    by_host_port: HashMap<(String, i64), String>,
}

#[derive(Clone)]
pub struct DbHostKeyPolicy {
    storage: Storage,
    pending: Arc<Mutex<PendingMismatchStore>>,
}

impl DbHostKeyPolicy {
    pub fn new(storage: Storage) -> Self {
        Self {
            storage,
            pending: Arc::new(Mutex::new(PendingMismatchStore::default())),
        }
    }

    pub async fn pending_mismatch_for_host_port(
        &self,
        host: &str,
        port: i64,
    ) -> Option<PendingHostKeyMismatch> {
        self.pending_mismatch_for_host_port_within(host, port, PENDING_MISMATCH_OPEN_WINDOW)
            .await
    }

    pub async fn apply_pending_mismatch(&self, token: &str, host: &str, port: i64) -> Result<()> {
        let pending = {
            let mut store = self.pending.lock().expect("pending mismatch lock poisoned");
            Self::prune_pending_locked(&mut store);
            store.by_token.get(token).cloned()
        }
        .ok_or_else(|| anyhow!("host key mismatch token is invalid or expired"))?;

        if pending.host != host || pending.port != port {
            return Err(anyhow!(
                "host key mismatch token does not match this connection"
            ));
        }

        self.storage
            .upsert_ssh_known_host(
                host,
                port,
                &pending.presented_key_type,
                &pending.presented_public_key,
            )
            .await?;

        let mut store = self.pending.lock().expect("pending mismatch lock poisoned");
        if let Some(current) = store.by_token.get(token) {
            let host_port = (current.host.clone(), current.port);
            store.by_token.remove(token);
            if store
                .by_host_port
                .get(&host_port)
                .is_some_and(|mapped| mapped == token)
            {
                store.by_host_port.remove(&host_port);
            }
        }

        Ok(())
    }

    async fn pending_mismatch_for_host_port_within(
        &self,
        host: &str,
        port: i64,
        max_age: Duration,
    ) -> Option<PendingHostKeyMismatch> {
        let mut store = self.pending.lock().expect("pending mismatch lock poisoned");
        Self::prune_pending_locked(&mut store);
        let token = store.by_host_port.get(&(host.to_string(), port))?.clone();
        let pending = store.by_token.get(&token)?.clone();
        if pending.created_at.elapsed() > max_age {
            return None;
        }
        Some(pending)
    }

    fn register_pending_mismatch(
        &self,
        host: &str,
        port: i64,
        stored_key_type: &str,
        stored_fingerprint: &str,
        presented_key_type: &str,
        presented_fingerprint: &str,
        presented_public_key: &str,
    ) -> String {
        let mut store = self.pending.lock().expect("pending mismatch lock poisoned");
        Self::prune_pending_locked(&mut store);

        let token = Uuid::new_v4().to_string();
        let pending = PendingHostKeyMismatch {
            token: token.clone(),
            host: host.to_string(),
            port,
            stored_key_type: stored_key_type.to_string(),
            stored_fingerprint: stored_fingerprint.to_string(),
            presented_key_type: presented_key_type.to_string(),
            presented_fingerprint: presented_fingerprint.to_string(),
            presented_public_key: presented_public_key.to_string(),
            created_at: Instant::now(),
        };

        let host_port = (host.to_string(), port);
        if let Some(previous_token) = store.by_host_port.insert(host_port.clone(), token.clone()) {
            store.by_token.remove(&previous_token);
        }
        store.by_token.insert(token.clone(), pending);
        token
    }

    fn prune_pending_locked(store: &mut PendingMismatchStore) {
        let expired_tokens: Vec<String> = store
            .by_token
            .iter()
            .filter_map(|(token, pending)| {
                if pending.created_at.elapsed() > PENDING_MISMATCH_TTL {
                    Some(token.clone())
                } else {
                    None
                }
            })
            .collect();

        for token in expired_tokens {
            if let Some(pending) = store.by_token.remove(&token) {
                let host_port = (pending.host, pending.port);
                if store
                    .by_host_port
                    .get(&host_port)
                    .is_some_and(|mapped| mapped == &token)
                {
                    store.by_host_port.remove(&host_port);
                }
            }
        }
    }
}

#[async_trait::async_trait]
impl HostKeyPolicy for DbHostKeyPolicy {
    async fn check_host_key(&self, check: HostKeyCheck<'_>) -> Result<HostKeyDecision> {
        if !check.strict_host_key {
            return Ok(HostKeyDecision::Accept);
        }

        let port = i64::from(check.port);
        let existing = self.storage.get_ssh_known_host(check.host, port).await?;

        match existing {
            None => {
                self.storage
                    .upsert_ssh_known_host(
                        check.host,
                        port,
                        &check.server_key.key_type,
                        &check.server_key.public_key,
                    )
                    .await?;

                tracing::info!(
                    host = check.host,
                    port = check.port,
                    key_type = %check.server_key.key_type,
                    fingerprint = %check.server_key.sha256_fingerprint,
                    "pinned first-seen SSH host key"
                );
            }
            Some(known_host) => {
                let keys_match = known_host.key_type == check.server_key.key_type
                    && known_host.public_key == check.server_key.public_key;

                if keys_match {
                    self.storage
                        .touch_ssh_known_host_seen(check.host, port)
                        .await?;

                    tracing::debug!(
                        host = check.host,
                        port = check.port,
                        key_type = %check.server_key.key_type,
                        fingerprint = %check.server_key.sha256_fingerprint,
                        "SSH host key matched saved key"
                    );
                } else {
                    let stored_fingerprint = fingerprint_from_public_key(&known_host.public_key)
                        .unwrap_or_else(|| "unknown".to_string());
                    let token = self.register_pending_mismatch(
                        check.host,
                        port,
                        &known_host.key_type,
                        &stored_fingerprint,
                        &check.server_key.key_type,
                        &check.server_key.sha256_fingerprint,
                        &check.server_key.public_key,
                    );

                    tracing::warn!(
                        host = check.host,
                        port = check.port,
                        mismatch_token = %token,
                        stored_key_type = %known_host.key_type,
                        stored_fingerprint = %stored_fingerprint,
                        presented_key_type = %check.server_key.key_type,
                        presented_fingerprint = %check.server_key.sha256_fingerprint,
                        "SSH host key mismatch; connection rejected until user confirms key update"
                    );

                    return Ok(HostKeyDecision::Reject);
                }
            }
        }

        Ok(HostKeyDecision::Accept)
    }
}

fn fingerprint_from_public_key(openssh_public_key: &str) -> Option<String> {
    let key = russh_keys::ssh_key::PublicKey::from_openssh(openssh_public_key).ok()?;
    Some(
        key.fingerprint(russh_keys::ssh_key::HashAlg::Sha256)
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db_path() -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("janus-test-{nanos}.sqlite"))
    }

    fn mock_key(key_type: &str, key_data: &str, fingerprint: &str) -> SshHostKey {
        SshHostKey {
            key_type: key_type.to_string(),
            public_key: format!("{key_type} {key_data}"),
            sha256_fingerprint: fingerprint.to_string(),
        }
    }

    #[tokio::test]
    async fn strict_disabled_does_not_store_host_key() {
        let db_path = temp_db_path();
        let storage = Storage::new(&db_path).await.expect("storage init");
        let policy = DbHostKeyPolicy::new(storage.clone());
        let key = mock_key(
            "ssh-ed25519",
            "AAAAC3NzaC1lZDI1NTE5AAAAITestKeyData",
            "SHA256:first",
        );

        let result = policy
            .check_host_key(HostKeyCheck {
                host: "example.com",
                port: 22,
                strict_host_key: false,
                server_key: &key,
            })
            .await
            .expect("host key check");
        assert_eq!(result, HostKeyDecision::Accept);

        let stored = storage
            .get_ssh_known_host("example.com", 22)
            .await
            .expect("read stored host");
        assert!(stored.is_none());

        let _ = std::fs::remove_file(db_path);
    }

    #[tokio::test]
    async fn strict_enabled_keeps_original_key_on_mismatch() {
        let db_path = temp_db_path();
        let storage = Storage::new(&db_path).await.expect("storage init");
        let policy = DbHostKeyPolicy::new(storage.clone());

        let first_key = mock_key(
            "ssh-ed25519",
            "AAAAC3NzaC1lZDI1NTE5AAAAIFirstKeyData",
            "SHA256:first",
        );
        policy
            .check_host_key(HostKeyCheck {
                host: "example.com",
                port: 22,
                strict_host_key: true,
                server_key: &first_key,
            })
            .await
            .expect("first strict check");

        let mismatch_key = mock_key(
            "ssh-rsa",
            "AAAAB3NzaC1yc2EAAAADAQABAAABAQMismatchedKeyData",
            "SHA256:mismatch",
        );
        let decision = policy
            .check_host_key(HostKeyCheck {
                host: "example.com",
                port: 22,
                strict_host_key: true,
                server_key: &mismatch_key,
            })
            .await
            .expect("mismatch strict check");
        assert_eq!(decision, HostKeyDecision::Reject);
        let mismatch = policy
            .pending_mismatch_for_host_port("example.com", 22)
            .await
            .expect("mismatch is staged");

        assert_eq!(mismatch.host, "example.com");
        assert_eq!(mismatch.port, 22);
        assert_eq!(mismatch.presented_key_type, "ssh-rsa");

        let stored = storage
            .get_ssh_known_host("example.com", 22)
            .await
            .expect("read stored host")
            .expect("stored host exists");

        assert_eq!(stored.key_type, "ssh-ed25519");
        assert_eq!(stored.public_key, first_key.public_key);

        policy
            .apply_pending_mismatch(&mismatch.token, "example.com", 22)
            .await
            .expect("apply mismatch");

        let stored_after_apply = storage
            .get_ssh_known_host("example.com", 22)
            .await
            .expect("read host after apply")
            .expect("stored host exists");

        assert_eq!(stored_after_apply.key_type, "ssh-rsa");
        assert_eq!(stored_after_apply.public_key, mismatch_key.public_key);

        let _ = std::fs::remove_file(db_path);
    }
}
