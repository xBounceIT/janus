use janus_domain::SecretKind;
use janus_secrets::VaultManager;

#[tokio::test]
async fn reports_initialization_status() {
    let file_path = std::env::temp_dir().join(format!("janus-vault-{}.json", uuid::Uuid::new_v4()));
    let vault = VaultManager::new(&file_path);

    assert!(!vault.is_initialized().await.expect("status before init"));

    vault.initialize("passphrase").await.expect("init");

    assert!(vault.is_initialized().await.expect("status after init"));

    let _ = std::fs::remove_file(file_path);
}

#[tokio::test]
async fn initialize_unlock_and_read_secret() {
    let file_path = std::env::temp_dir().join(format!("janus-vault-{}.json", uuid::Uuid::new_v4()));
    let vault = VaultManager::new(&file_path);

    vault.initialize("passphrase").await.expect("init");
    vault.unlock("passphrase").await.expect("unlock");

    let secret = vault
        .put_secret(SecretKind::Password, "super-secret")
        .await
        .expect("store secret");

    let loaded = vault.get_secret(&secret.id).expect("get secret");
    assert_eq!(loaded.as_deref(), Some("super-secret"));

    let _ = std::fs::remove_file(file_path);
}
