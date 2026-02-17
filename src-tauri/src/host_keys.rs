use anyhow::Result;
use janus_protocol_ssh::{HostKeyCheck, HostKeyDecision, HostKeyPolicy};
#[cfg(test)]
use janus_protocol_ssh::SshHostKey;
use janus_storage::Storage;

#[derive(Clone)]
pub struct DbHostKeyPolicy {
    storage: Storage,
}

impl DbHostKeyPolicy {
    pub fn new(storage: Storage) -> Self {
        Self { storage }
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

                    tracing::warn!(
                        host = check.host,
                        port = check.port,
                        stored_key_type = %known_host.key_type,
                        stored_fingerprint = %stored_fingerprint,
                        presented_key_type = %check.server_key.key_type,
                        presented_fingerprint = %check.server_key.sha256_fingerprint,
                        "SSH host key mismatch; keeping saved key and allowing connection per warn-only policy"
                    );
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
        policy
            .check_host_key(HostKeyCheck {
                host: "example.com",
                port: 22,
                strict_host_key: true,
                server_key: &mismatch_key,
            })
            .await
            .expect("mismatch strict check");

        let stored = storage
            .get_ssh_known_host("example.com", 22)
            .await
            .expect("read stored host")
            .expect("stored host exists");

        assert_eq!(stored.key_type, "ssh-ed25519");
        assert_eq!(stored.public_key, first_key.public_key);

        let _ = std::fs::remove_file(db_path);
    }
}
