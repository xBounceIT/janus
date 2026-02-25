use janus_domain::{ConnectionUpsert, FolderUpsert, NodeKind, NodeMoveRequest, SshConfigInput};
use janus_storage::{ResolvedSecretRefs, Storage};

fn ssh_connection(
    id: &str,
    parent_id: Option<&str>,
    name: &str,
    order_index: i64,
) -> ConnectionUpsert {
    ConnectionUpsert {
        id: id.into(),
        parent_id: parent_id.map(str::to_string),
        kind: NodeKind::Ssh,
        name: name.into(),
        order_index,
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
    }
}

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

#[tokio::test]
async fn moves_nodes_across_parents_and_reorders() {
    let db_path = std::env::temp_dir().join(format!("janus-test-{}.sqlite", uuid::Uuid::new_v4()));
    let storage = Storage::new(&db_path).await.expect("storage init");

    storage
        .upsert_folder(&FolderUpsert {
            id: "folder-a".into(),
            parent_id: None,
            name: "Folder A".into(),
            order_index: 0,
        })
        .await
        .expect("folder a upsert");

    storage
        .upsert_connection(&ssh_connection("conn-a", None, "Conn A", 1), &ResolvedSecretRefs::default())
        .await
        .expect("conn a upsert");

    storage
        .upsert_connection(&ssh_connection("conn-b", None, "Conn B", 2), &ResolvedSecretRefs::default())
        .await
        .expect("conn b upsert");

    storage
        .upsert_connection(
            &ssh_connection("conn-c", Some("folder-a"), "Conn C", 0),
            &ResolvedSecretRefs::default(),
        )
        .await
        .expect("conn c upsert");

    storage
        .move_node(&NodeMoveRequest {
            node_id: "conn-b".into(),
            new_parent_id: None,
            new_index: 1,
        })
        .await
        .expect("reorder root siblings");

    storage
        .move_node(&NodeMoveRequest {
            node_id: "conn-a".into(),
            new_parent_id: Some("folder-a".into()),
            new_index: 1,
        })
        .await
        .expect("move conn a into folder");

    storage
        .move_node(&NodeMoveRequest {
            node_id: "conn-c".into(),
            new_parent_id: None,
            new_index: 0,
        })
        .await
        .expect("move conn c to root");

    let tree = storage.list_tree().await.expect("list tree");
    let root_ids: Vec<_> = tree
        .iter()
        .filter(|node| node.parent_id.is_none())
        .map(|node| (node.id.as_str(), node.order_index))
        .collect();
    assert_eq!(root_ids, vec![("conn-c", 0), ("folder-a", 1), ("conn-b", 2)]);

    let folder_a_children: Vec<_> = tree
        .iter()
        .filter(|node| node.parent_id.as_deref() == Some("folder-a"))
        .map(|node| (node.id.as_str(), node.order_index))
        .collect();
    assert_eq!(folder_a_children, vec![("conn-a", 0)]);

    let _ = std::fs::remove_file(db_path);
}

#[tokio::test]
async fn move_node_rejects_non_folder_parent() {
    let db_path = std::env::temp_dir().join(format!("janus-test-{}.sqlite", uuid::Uuid::new_v4()));
    let storage = Storage::new(&db_path).await.expect("storage init");

    storage
        .upsert_connection(&ssh_connection("conn-a", None, "Conn A", 0), &ResolvedSecretRefs::default())
        .await
        .expect("conn a upsert");
    storage
        .upsert_connection(&ssh_connection("conn-b", None, "Conn B", 1), &ResolvedSecretRefs::default())
        .await
        .expect("conn b upsert");

    let error = storage
        .move_node(&NodeMoveRequest {
            node_id: "conn-b".into(),
            new_parent_id: Some("conn-a".into()),
            new_index: 0,
        })
        .await
        .expect_err("move into non-folder should fail");

    assert!(error.to_string().contains("folder"));

    let _ = std::fs::remove_file(db_path);
}

#[tokio::test]
async fn move_node_rejects_folder_cycle() {
    let db_path = std::env::temp_dir().join(format!("janus-test-{}.sqlite", uuid::Uuid::new_v4()));
    let storage = Storage::new(&db_path).await.expect("storage init");

    storage
        .upsert_folder(&FolderUpsert {
            id: "folder-a".into(),
            parent_id: None,
            name: "Folder A".into(),
            order_index: 0,
        })
        .await
        .expect("folder a upsert");
    storage
        .upsert_folder(&FolderUpsert {
            id: "folder-b".into(),
            parent_id: Some("folder-a".into()),
            name: "Folder B".into(),
            order_index: 0,
        })
        .await
        .expect("folder b upsert");

    let error = storage
        .move_node(&NodeMoveRequest {
            node_id: "folder-a".into(),
            new_parent_id: Some("folder-b".into()),
            new_index: 0,
        })
        .await
        .expect_err("folder cycle should fail");

    assert!(error.to_string().contains("descendant"));

    let _ = std::fs::remove_file(db_path);
}
