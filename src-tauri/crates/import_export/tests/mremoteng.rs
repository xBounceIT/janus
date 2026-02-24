use janus_import_export::parse_mremoteng;
use std::path::Path;
use janus_domain::NodeKind;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn parses_core_nodes_from_fixture() {
    let parsed = parse_mremoteng(Path::new("../../../fixtures/sample-mremoteng.xml"))
        .expect("fixture should parse");

    assert_eq!(parsed.folders.len(), 1);
    assert_eq!(parsed.connections.len(), 2);
    assert!(parsed.warnings.is_empty());
}

#[test]
fn trims_connection_attributes_before_mapping() {
    let temp_file = std::env::temp_dir().join(format!(
        "janus-import-export-{}-{}.xml",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time should be monotonic")
            .as_nanos()
    ));

    let xml = r#"
<Connections>
  <Node Name=" Folder " Type="  Container ">
    <Node Name=" SSH node " Protocol="  SSH2  " Hostname=" host.example.com  " Port=" 2200 " Username=" admin  " />
    <Node Name=" RDP node " ConnectionType="  RDP  " Host="  rdp.example.com " Port=" 3390 " Username="  corp-user " />
  </Node>
</Connections>
"#;

    std::fs::write(&temp_file, xml).expect("temp xml should be written");

    let parsed = parse_mremoteng(&temp_file).expect("xml should parse");
    let _ = std::fs::remove_file(&temp_file);

    assert_eq!(parsed.folders.len(), 1);
    assert_eq!(parsed.connections.len(), 2);
    assert!(parsed.warnings.is_empty());

    let ssh = parsed
        .connections
        .iter()
        .find_map(|connection| connection.ssh.as_ref())
        .expect("ssh node should be parsed");
    assert_eq!(ssh.host, "host.example.com");
    assert_eq!(ssh.port, 2200);
    assert_eq!(ssh.username, "admin");

    let rdp = parsed
        .connections
        .iter()
        .find_map(|connection| connection.rdp.as_ref())
        .expect("rdp node should be parsed");
    assert_eq!(rdp.host, "rdp.example.com");
    assert_eq!(rdp.port, 3390);
    assert_eq!(rdp.username.as_deref(), Some("corp-user"));
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
