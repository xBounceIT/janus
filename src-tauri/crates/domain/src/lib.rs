use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Folder,
    Ssh,
    Rdp,
}

impl NodeKind {
    pub fn as_db_str(&self) -> &'static str {
        match self {
            Self::Folder => "folder",
            Self::Ssh => "ssh",
            Self::Rdp => "rdp",
        }
    }

    pub fn from_db_str(value: &str) -> Option<Self> {
        match value {
            "folder" => Some(Self::Folder),
            "ssh" => Some(Self::Ssh),
            "rdp" => Some(Self::Rdp),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRef {
    pub id: String,
    pub kind: SecretKind,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretKind {
    Password,
    KeyPassphrase,
    RdpPassword,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: NodeKind,
    pub name: String,
    pub order_index: i64,
    pub ssh: Option<SshConfig>,
    pub rdp: Option<RdpConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    pub port: i64,
    pub username: String,
    pub strict_host_key: bool,
    pub key_path: Option<String>,
    pub auth_ref: Option<String>,
    pub key_passphrase_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpConfig {
    pub host: String,
    pub port: i64,
    pub username: Option<String>,
    pub domain: Option<String>,
    pub screen_mode: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub credential_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderUpsert {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub order_index: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigInput {
    pub host: String,
    pub port: i64,
    pub username: String,
    pub strict_host_key: bool,
    pub key_path: Option<String>,
    pub password: Option<String>,
    pub key_passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpConfigInput {
    pub host: String,
    pub port: i64,
    pub username: Option<String>,
    pub domain: Option<String>,
    pub screen_mode: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionUpsert {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: NodeKind,
    pub name: String,
    pub order_index: i64,
    pub ssh: Option<SshConfigInput>,
    pub rdp: Option<RdpConfigInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportMode {
    DryRun,
    Apply,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub created: usize,
    pub updated: usize,
    pub skipped: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportScope {
    pub include_secrets: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOptions {
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpLaunchOptions {
    pub full_screen: Option<bool>,
}
