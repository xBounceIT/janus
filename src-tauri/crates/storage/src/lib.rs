use std::path::Path;

use anyhow::{anyhow, Context, Result};
use janus_domain::{ConnectionNode, ConnectionUpsert, FolderUpsert, NodeKind, RdpConfig, SshConfig};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};

#[derive(Debug, Default, Clone)]
pub struct ResolvedSecretRefs {
    pub ssh_password_ref: Option<String>,
    pub ssh_key_passphrase_ref: Option<String>,
    pub rdp_password_ref: Option<String>,
}

#[derive(Clone)]
pub struct Storage {
    pool: SqlitePool,
}

impl Storage {
    pub async fn new(db_path: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("creating db directory {}", parent.display()))?;
        }

        let options = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true)
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await
            .context("connecting to sqlite")?;

        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .context("running sqlite migrations")?;

        Ok(Self { pool })
    }

    pub async fn list_tree(&self) -> Result<Vec<ConnectionNode>> {
        let rows = sqlx::query(
            "SELECT id, parent_id, kind, name, order_index
             FROM nodes
             ORDER BY COALESCE(parent_id, ''), order_index, name",
        )
        .fetch_all(&self.pool)
        .await
        .context("listing nodes")?;

        let mut nodes = Vec::with_capacity(rows.len());
        for row in rows {
            let id: String = row.try_get("id")?;
            let kind_raw: String = row.try_get("kind")?;
            let kind = NodeKind::from_db_str(&kind_raw)
                .ok_or_else(|| anyhow!("invalid node kind in db: {kind_raw}"))?;

            let ssh = if kind == NodeKind::Ssh {
                Some(self.get_ssh_config(&id).await?)
            } else {
                None
            };

            let rdp = if kind == NodeKind::Rdp {
                Some(self.get_rdp_config(&id).await?)
            } else {
                None
            };

            nodes.push(ConnectionNode {
                id,
                parent_id: row.try_get("parent_id")?,
                kind,
                name: row.try_get("name")?,
                order_index: row.try_get("order_index")?,
                ssh,
                rdp,
            });
        }

        Ok(nodes)
    }

    pub async fn get_node(&self, node_id: &str) -> Result<Option<ConnectionNode>> {
        let row = sqlx::query(
            "SELECT id, parent_id, kind, name, order_index
             FROM nodes WHERE id = ?1",
        )
        .bind(node_id)
        .fetch_optional(&self.pool)
        .await
        .context("fetching node")?;

        let Some(row) = row else {
            return Ok(None);
        };

        let kind_raw: String = row.try_get("kind")?;
        let kind = NodeKind::from_db_str(&kind_raw)
            .ok_or_else(|| anyhow!("invalid node kind in db: {kind_raw}"))?;

        let ssh = if kind == NodeKind::Ssh {
            Some(self.get_ssh_config(node_id).await?)
        } else {
            None
        };

        let rdp = if kind == NodeKind::Rdp {
            Some(self.get_rdp_config(node_id).await?)
        } else {
            None
        };

        Ok(Some(ConnectionNode {
            id: row.try_get("id")?,
            parent_id: row.try_get("parent_id")?,
            kind,
            name: row.try_get("name")?,
            order_index: row.try_get("order_index")?,
            ssh,
            rdp,
        }))
    }

    pub async fn upsert_folder(&self, folder: &FolderUpsert) -> Result<()> {
        sqlx::query(
            "INSERT INTO nodes (id, parent_id, kind, name, order_index, created_at, updated_at)
             VALUES (?1, ?2, 'folder', ?3, ?4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(id) DO UPDATE
             SET parent_id = excluded.parent_id,
                 kind = 'folder',
                 name = excluded.name,
                 order_index = excluded.order_index,
                 updated_at = CURRENT_TIMESTAMP",
        )
        .bind(&folder.id)
        .bind(&folder.parent_id)
        .bind(&folder.name)
        .bind(folder.order_index)
        .execute(&self.pool)
        .await
        .context("upserting folder node")?;

        Ok(())
    }

    pub async fn upsert_connection(
        &self,
        connection: &ConnectionUpsert,
        refs: &ResolvedSecretRefs,
    ) -> Result<()> {
        if connection.kind == NodeKind::Folder {
            return Err(anyhow!("connection upsert cannot use folder kind"));
        }

        let mut tx = self.pool.begin().await.context("opening transaction")?;

        sqlx::query(
            "INSERT INTO nodes (id, parent_id, kind, name, order_index, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(id) DO UPDATE
             SET parent_id = excluded.parent_id,
                 kind = excluded.kind,
                 name = excluded.name,
                 order_index = excluded.order_index,
                 updated_at = CURRENT_TIMESTAMP",
        )
        .bind(&connection.id)
        .bind(&connection.parent_id)
        .bind(connection.kind.as_db_str())
        .bind(&connection.name)
        .bind(connection.order_index)
        .execute(&mut *tx)
        .await
        .context("upserting connection node")?;

        match connection.kind {
            NodeKind::Ssh => {
                let Some(ssh) = connection.ssh.as_ref() else {
                    return Err(anyhow!("missing ssh payload"));
                };

                sqlx::query("DELETE FROM rdp_configs WHERE node_id = ?1")
                    .bind(&connection.id)
                    .execute(&mut *tx)
                    .await
                    .context("clearing stale rdp config")?;

                sqlx::query(
                    "INSERT INTO ssh_configs (node_id, host, port, username, strict_host_key, key_path, auth_ref, key_passphrase_ref)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT(node_id) DO UPDATE
                     SET host = excluded.host,
                         port = excluded.port,
                         username = excluded.username,
                         strict_host_key = excluded.strict_host_key,
                         key_path = excluded.key_path,
                         auth_ref = COALESCE(excluded.auth_ref, ssh_configs.auth_ref),
                         key_passphrase_ref = COALESCE(excluded.key_passphrase_ref, ssh_configs.key_passphrase_ref)",
                )
                .bind(&connection.id)
                .bind(&ssh.host)
                .bind(ssh.port)
                .bind(&ssh.username)
                .bind(if ssh.strict_host_key { 1_i64 } else { 0_i64 })
                .bind(&ssh.key_path)
                .bind(&refs.ssh_password_ref)
                .bind(&refs.ssh_key_passphrase_ref)
                .execute(&mut *tx)
                .await
                .context("upserting ssh config")?;
            }
            NodeKind::Rdp => {
                let Some(rdp) = connection.rdp.as_ref() else {
                    return Err(anyhow!("missing rdp payload"));
                };

                sqlx::query("DELETE FROM ssh_configs WHERE node_id = ?1")
                    .bind(&connection.id)
                    .execute(&mut *tx)
                    .await
                    .context("clearing stale ssh config")?;

                let credential_ref = refs.rdp_password_ref.clone();

                sqlx::query(
                    "INSERT INTO rdp_configs (node_id, host, port, username, domain, screen_mode, width, height, credential_ref)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                     ON CONFLICT(node_id) DO UPDATE
                     SET host = excluded.host,
                         port = excluded.port,
                         username = excluded.username,
                         domain = excluded.domain,
                         screen_mode = excluded.screen_mode,
                         width = excluded.width,
                         height = excluded.height,
                         credential_ref = COALESCE(excluded.credential_ref, rdp_configs.credential_ref)",
                )
                .bind(&connection.id)
                .bind(&rdp.host)
                .bind(rdp.port)
                .bind(&rdp.username)
                .bind(&rdp.domain)
                .bind(rdp.screen_mode)
                .bind(rdp.width)
                .bind(rdp.height)
                .bind(credential_ref)
                .execute(&mut *tx)
                .await
                .context("upserting rdp config")?;
            }
            NodeKind::Folder => unreachable!(),
        }

        tx.commit().await.context("committing upsert transaction")?;
        Ok(())
    }

    pub async fn delete_node(&self, node_id: &str) -> Result<()> {
        sqlx::query("DELETE FROM nodes WHERE id = ?1")
            .bind(node_id)
            .execute(&self.pool)
            .await
            .context("deleting node")?;
        Ok(())
    }

    fn parse_bool(value: i64) -> bool {
        value != 0
    }

    async fn get_ssh_config(&self, node_id: &str) -> Result<SshConfig> {
        let row = sqlx::query(
            "SELECT host, port, username, strict_host_key, key_path, auth_ref, key_passphrase_ref
             FROM ssh_configs WHERE node_id = ?1",
        )
        .bind(node_id)
        .fetch_optional(&self.pool)
        .await
        .context("fetching ssh config")?
        .ok_or_else(|| anyhow!("missing ssh config for node {node_id}"))?;

        Ok(SshConfig {
            host: row.try_get("host")?,
            port: row.try_get("port")?,
            username: row.try_get("username")?,
            strict_host_key: Self::parse_bool(row.try_get("strict_host_key")?),
            key_path: row.try_get("key_path")?,
            auth_ref: row.try_get("auth_ref")?,
            key_passphrase_ref: row.try_get("key_passphrase_ref")?,
        })
    }

    async fn get_rdp_config(&self, node_id: &str) -> Result<RdpConfig> {
        let row = sqlx::query(
            "SELECT host, port, username, domain, screen_mode, width, height, credential_ref
             FROM rdp_configs WHERE node_id = ?1",
        )
        .bind(node_id)
        .fetch_optional(&self.pool)
        .await
        .context("fetching rdp config")?
        .ok_or_else(|| anyhow!("missing rdp config for node {node_id}"))?;

        Ok(RdpConfig {
            host: row.try_get("host")?,
            port: row.try_get("port")?,
            username: row.try_get("username")?,
            domain: row.try_get("domain")?,
            screen_mode: row.try_get("screen_mode")?,
            width: row.try_get("width")?,
            height: row.try_get("height")?,
            credential_ref: row.try_get("credential_ref")?,
        })
    }
}
