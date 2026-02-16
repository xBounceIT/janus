use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};
use janus_domain::{
    ConnectionNode, ConnectionUpsert, FolderUpsert, ImportReport, NodeKind, RdpConfigInput, SshConfigInput,
};
use quick_xml::events::{BytesDecl, BytesEnd, BytesStart, Event};
use quick_xml::Writer;
use roxmltree::Document;
use uuid::Uuid;

#[derive(Debug, Default)]
pub struct ParsedImport {
    pub folders: Vec<FolderUpsert>,
    pub connections: Vec<ConnectionUpsert>,
    pub warnings: Vec<String>,
}

pub fn parse_mremoteng(path: &Path) -> Result<ParsedImport> {
    let xml = std::fs::read_to_string(path)
        .with_context(|| format!("reading import XML {}", path.display()))?;
    let doc = Document::parse(&xml).context("parsing mRemoteNG XML")?;

    let root = doc.root_element();
    let mut parsed = ParsedImport::default();

    for child in root.children().filter(|node| node.is_element()) {
        parse_node(child, None, &mut parsed);
    }

    Ok(parsed)
}

fn parse_node(node: roxmltree::Node<'_, '_>, parent_id: Option<String>, parsed: &mut ParsedImport) {
    let tag = node.tag_name().name();
    if tag != "Node" && tag != "Connection" && tag != "Container" {
        for child in node.children().filter(|child| child.is_element()) {
            parse_node(child, parent_id.clone(), parsed);
        }
        return;
    }

    let node_id = Uuid::new_v4().to_string();
    let name = node.attribute("Name").unwrap_or("Imported Node").to_string();
    let type_attr = node.attribute("Type").unwrap_or_default();
    let protocol = node
        .attribute("Protocol")
        .or_else(|| node.attribute("ConnectionType"))
        .unwrap_or_default();

    let is_folder = type_attr.eq_ignore_ascii_case("container")
        || tag.eq_ignore_ascii_case("container")
        || protocol.is_empty() && node.children().any(|child| child.is_element());

    if is_folder {
        parsed.folders.push(FolderUpsert {
            id: node_id.clone(),
            parent_id: parent_id.clone(),
            name,
            order_index: parsed.folders.len() as i64,
        });

        for child in node.children().filter(|child| child.is_element()) {
            parse_node(child, Some(node_id.clone()), parsed);
        }
        return;
    }

    let host = node
        .attribute("Hostname")
        .or_else(|| node.attribute("Host"))
        .unwrap_or_default()
        .to_string();
    let port = node
        .attribute("Port")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_else(|| if protocol.eq_ignore_ascii_case("RDP") { 3389 } else { 22 });
    let username = node.attribute("Username").unwrap_or_default().to_string();

    if protocol.eq_ignore_ascii_case("RDP") {
        parsed.connections.push(ConnectionUpsert {
            id: node_id,
            parent_id,
            kind: NodeKind::Rdp,
            name: name.clone(),
            order_index: parsed.connections.len() as i64,
            ssh: None,
            rdp: Some(RdpConfigInput {
                host,
                port,
                username: if username.is_empty() { None } else { Some(username) },
                domain: node.attribute("Domain").map(ToOwned::to_owned),
                screen_mode: 2,
                width: None,
                height: None,
                password: None,
            }),
        });

        if node.attribute("Password").is_some() {
            parsed
                .warnings
                .push(format!("Skipped direct RDP password import for node '{name}'."));
        }
    } else if protocol.eq_ignore_ascii_case("SSH2") || protocol.eq_ignore_ascii_case("SSH") {
        parsed.connections.push(ConnectionUpsert {
            id: node_id,
            parent_id,
            kind: NodeKind::Ssh,
            name: name.clone(),
            order_index: parsed.connections.len() as i64,
            ssh: Some(SshConfigInput {
                host,
                port,
                username,
                strict_host_key: true,
                key_path: None,
                password: None,
                key_passphrase: None,
            }),
            rdp: None,
        });

        if node.attribute("Password").is_some() {
            parsed
                .warnings
                .push(format!("Skipped direct SSH password import for node '{name}'."));
        }
    } else {
        parsed
            .warnings
            .push(format!("Unsupported protocol '{protocol}' on node '{name}', skipped."));
    }
}

pub fn apply_report(parsed: &ParsedImport, created: usize, updated: usize, skipped: usize) -> ImportReport {
    ImportReport {
        created,
        updated,
        skipped,
        warnings: parsed.warnings.clone(),
    }
}

pub fn export_mremoteng(path: &Path, nodes: &[ConnectionNode]) -> Result<()> {
    let mut writer = Writer::new_with_indent(Vec::new(), b' ', 2);
    writer
        .write_event(Event::Decl(BytesDecl::new("1.0", Some("UTF-8"), None)))
        .context("writing xml declaration")?;

    let mut root = BytesStart::new("Connections");
    root.push_attribute(("Name", "Connections"));
    writer
        .write_event(Event::Start(root))
        .context("writing root start")?;

    let mut by_parent: HashMap<Option<String>, Vec<&ConnectionNode>> = HashMap::new();
    for node in nodes {
        by_parent
            .entry(node.parent_id.clone())
            .or_default()
            .push(node);
    }

    fn write_branch(
        writer: &mut Writer<Vec<u8>>,
        by_parent: &HashMap<Option<String>, Vec<&ConnectionNode>>,
        parent_id: Option<&str>,
    ) -> Result<()> {
        let key = parent_id.map(ToOwned::to_owned);
        if let Some(children) = by_parent.get(&key) {
            let mut ordered = children.clone();
            ordered.sort_by_key(|node| node.order_index);

            for node in ordered {
                let mut element = BytesStart::new("Node");
                element.push_attribute(("Name", node.name.as_str()));

                match node.kind {
                    NodeKind::Folder => {
                        element.push_attribute(("Type", "Container"));
                        writer.write_event(Event::Start(element.to_owned()))?;
                        write_branch(writer, by_parent, Some(node.id.as_str()))?;
                        writer.write_event(Event::End(BytesEnd::new("Node")))?;
                    }
                    NodeKind::Ssh => {
                        if let Some(ssh) = &node.ssh {
                            element.push_attribute(("Protocol", "SSH2"));
                            element.push_attribute(("Hostname", ssh.host.as_str()));
                            let port = ssh.port.to_string();
                            element.push_attribute(("Port", port.as_str()));
                            element.push_attribute(("Username", ssh.username.as_str()));
                        }
                        writer.write_event(Event::Empty(element))?;
                    }
                    NodeKind::Rdp => {
                        if let Some(rdp) = &node.rdp {
                            element.push_attribute(("Protocol", "RDP"));
                            element.push_attribute(("Hostname", rdp.host.as_str()));
                            let port = rdp.port.to_string();
                            element.push_attribute(("Port", port.as_str()));
                            if let Some(username) = &rdp.username {
                                element.push_attribute(("Username", username.as_str()));
                            }
                            if let Some(domain) = &rdp.domain {
                                element.push_attribute(("Domain", domain.as_str()));
                            }
                        }
                        writer.write_event(Event::Empty(element))?;
                    }
                }
            }
        }

        Ok(())
    }

    write_branch(&mut writer, &by_parent, None)?;

    writer
        .write_event(Event::End(BytesEnd::new("Connections")))
        .context("writing root end")?;

    let bytes = writer.into_inner();
    std::fs::write(path, bytes).with_context(|| format!("writing export XML {}", path.display()))?;
    Ok(())
}
