use janus_import_export::parse_mremoteng;

#[test]
fn parses_core_nodes_from_fixture() {
    let parsed = parse_mremoteng(std::path::Path::new("../../../fixtures/sample-mremoteng.xml"))
        .expect("fixture should parse");

    assert_eq!(parsed.folders.len(), 1);
    assert_eq!(parsed.connections.len(), 2);
    assert!(parsed.warnings.is_empty());
}
