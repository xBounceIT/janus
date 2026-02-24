use janus_import_export::parse_mremoteng;
use janus_domain::NodeKind;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn parses_core_nodes_from_fixture() {
    let parsed = parse_mremoteng(std::path::Path::new("../../../fixtures/sample-mremoteng.xml"))
        .expect("fixture should parse");

    assert_eq!(parsed.folders.len(), 1);
    assert_eq!(parsed.connections.len(), 2);
    assert!(parsed.warnings.is_empty());
}

#[test]
fn parses_ssh2_connection_and_skips_password_warning() {
    let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<Connections>
  <Node
    Name="Office SSH"
    Type="Connection"
    Protocol="SSH2"
    Hostname="192.168.1.16"
    Port="22"
    Username="daniel"
    Password="super-secret"
  />
</Connections>"#;

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("current time should be after unix epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("janus-mremoteng-{unique}.xml"));

    std::fs::write(&path, xml).expect("temporary XML fixture should be written");
    let parsed = parse_mremoteng(&path).expect("inline fixture should parse");
    std::fs::remove_file(&path).expect("temporary XML fixture should be removed");

    assert_eq!(parsed.connections.len(), 1);
    assert_eq!(parsed.folders.len(), 0);

    let conn = &parsed.connections[0];
    assert_eq!(conn.kind, NodeKind::Ssh);
    let ssh = conn
        .ssh
        .as_ref()
        .expect("ssh payload should be present for ssh nodes");
    assert_eq!(ssh.host, "192.168.1.16");
    assert_eq!(ssh.port, 22);
    assert_eq!(ssh.username, "daniel");

    assert!(
        parsed
            .warnings
            .iter()
            .any(|warning| warning == "Skipped direct SSH password import for node 'Office SSH'.")
    );
    assert!(
        parsed
            .warnings
            .iter()
            .all(|warning| !warning.contains("Unsupported protocol"))
    );
}
