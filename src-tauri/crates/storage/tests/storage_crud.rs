use janus_domain::{ConnectionUpsert, FolderUpsert, NodeKind, SshConfigInput};
use janus_storage::{ResolvedSecretRefs, Storage};

#[tokio::test]
async fn upserts_and_reads_tree() {
    let db_path = std::env::temp_dir().join(format!("janus-test-{}.sqlite", uuid::Uuid::new_v4()));
    let storage = Storage::new(&db_path).await.expect("storage init");

    storage
        .upsert_folder(&FolderUpsert {
            id: "folder-1".into(),
            parent_id: None,
            name: "Folder".into(),
            order_index: 1,
        })
        .await
        .expect("folder upsert");

    let conn = ConnectionUpsert {
        id: "conn-1".into(),
        parent_id: Some("folder-1".into()),
        kind: NodeKind::Ssh,
        name: "SSH".into(),
        order_index: 2,
        ssh: Some(SshConfigInput {
            host: "localhost".into(),
            port: 22,
            username: "user".into(),
            strict_host_key: true,
            key_path: None,
            password: None,
            key_passphrase: None,
        }),
        rdp: None,
    };

    storage
        .upsert_connection(&conn, &ResolvedSecretRefs::default())
        .await
        .expect("connection upsert");

    let tree = storage.list_tree().await.expect("list tree");
    assert_eq!(tree.len(), 2);

    let _ = std::fs::remove_file(db_path);
}

#[tokio::test]
async fn upserts_and_reads_ssh_known_hosts() {
    let db_path = std::env::temp_dir().join(format!("janus-test-{}.sqlite", uuid::Uuid::new_v4()));
    let storage = Storage::new(&db_path).await.expect("storage init");

    storage
        .upsert_ssh_known_host(
            "example.com",
            22,
            "ssh-ed25519",
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKeyData",
        )
        .await
        .expect("upsert first known host");

    let first = storage
        .get_ssh_known_host("example.com", 22)
        .await
        .expect("read known host")
        .expect("known host present");
    assert_eq!(first.host, "example.com");
    assert_eq!(first.port, 22);
    assert_eq!(first.key_type, "ssh-ed25519");

    storage
        .upsert_ssh_known_host(
            "example.com",
            22,
            "ssh-rsa",
            "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQMockKeyData",
        )
        .await
        .expect("upsert known host replacement");

    let second = storage
        .get_ssh_known_host("example.com", 22)
        .await
        .expect("read known host after replacement")
        .expect("known host present");
    assert_eq!(second.key_type, "ssh-rsa");
    assert_eq!(
        second.public_key,
        "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQMockKeyData"
    );

    storage
        .touch_ssh_known_host_seen("example.com", 22)
        .await
        .expect("touch known host");

    let _ = std::fs::remove_file(db_path);
}
