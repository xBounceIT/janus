use std::collections::HashMap;
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use janus_domain::{
    ConnectionNode, ConnectionUpsert, FolderUpsert, NodeKind, NodeMoveRequest, RdpConfig,
    SshConfig,
};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};

#[derive(Debug, Default, Clone)]
pub struct ResolvedSecretRefs {
    pub ssh_password_ref: Option<String>,
    pub ssh_key_passphrase_ref: Option<String>,
    pub rdp_password_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshKnownHost {
    pub host: String,
    pub port: i64,
    pub key_type: String,
    pub public_key: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_seen_at: String,
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

    pub async fn move_node(&self, request: &NodeMoveRequest) -> Result<()> {
        let mut tx = self
            .pool
            .begin()
            .await
            .context("opening node move transaction")?;

        let rows = sqlx::query("SELECT id, parent_id, kind FROM nodes")
            .fetch_all(&mut *tx)
            .await
            .context("loading nodes for move validation")?;

        let mut parents = HashMap::<String, Option<String>>::with_capacity(rows.len());
        let mut kinds = HashMap::<String, NodeKind>::with_capacity(rows.len());
        for row in rows {
            let id: String = row.try_get("id")?;
            let kind_raw: String = row.try_get("kind")?;
            let kind = NodeKind::from_db_str(&kind_raw)
                .ok_or_else(|| anyhow!("invalid node kind in db: {kind_raw}"))?;
            let parent_id: Option<String> = row.try_get("parent_id")?;
            parents.insert(id.clone(), parent_id);
            kinds.insert(id, kind);
        }

        let Some(old_parent_id) = parents.get(&request.node_id).cloned() else {
            return Err(anyhow!("node not found"));
        };
        let Some(moving_kind) = kinds.get(&request.node_id).copied() else {
            return Err(anyhow!("node kind not found"));
        };

        if let Some(new_parent_id) = request.new_parent_id.as_deref() {
            if new_parent_id == request.node_id {
                return Err(anyhow!("cannot move a node into itself"));
            }

            let Some(parent_kind) = kinds.get(new_parent_id).copied() else {
                return Err(anyhow!("destination folder not found"));
            };
            if parent_kind != NodeKind::Folder {
                return Err(anyhow!("destination parent must be a folder"));
            }
        }

        if moving_kind == NodeKind::Folder {
            let mut cursor = request.new_parent_id.clone();
            while let Some(parent_id) = cursor {
                if parent_id == request.node_id {
                    return Err(anyhow!("cannot move a folder into its descendant"));
                }
                cursor = parents.get(&parent_id).cloned().flatten();
            }
        }

        let requested_index = request.new_index.max(0) as usize;
        let same_parent = old_parent_id == request.new_parent_id;

        let sibling_query = "SELECT id
             FROM nodes
             WHERE ((?1 IS NULL AND parent_id IS NULL) OR parent_id = ?1)
             ORDER BY order_index, name";

        let old_sibling_rows = sqlx::query(sibling_query)
            .bind(old_parent_id.as_deref())
            .fetch_all(&mut *tx)
            .await
            .context("loading old sibling set")?;
        let mut old_siblings: Vec<String> = old_sibling_rows
            .into_iter()
            .map(|row| row.try_get("id"))
            .collect::<std::result::Result<_, _>>()?;

        let Some(old_pos) = old_siblings.iter().position(|id| id == &request.node_id) else {
            return Err(anyhow!("node not found in sibling set"));
        };

        let old_siblings_original = old_siblings.clone();
        old_siblings.remove(old_pos);

        if same_parent {
            let insert_at = requested_index.min(old_siblings.len());
            old_siblings.insert(insert_at, request.node_id.clone());

            if old_siblings == old_siblings_original {
                return Ok(());
            }

            for (order_index, node_id) in old_siblings.iter().enumerate() {
                sqlx::query(
                    "UPDATE nodes
                     SET order_index = ?1,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?2",
                )
                .bind(order_index as i64)
                .bind(node_id)
                .execute(&mut *tx)
                .await
                .context("renumbering sibling order after move")?;
            }

            tx.commit().await.context("committing node move transaction")?;
            return Ok(());
        }

        let new_sibling_rows = sqlx::query(sibling_query)
            .bind(request.new_parent_id.as_deref())
            .fetch_all(&mut *tx)
            .await
            .context("loading new sibling set")?;
        let mut new_siblings: Vec<String> = new_sibling_rows
            .into_iter()
            .map(|row| row.try_get("id"))
            .collect::<std::result::Result<_, _>>()?;

        let insert_at = requested_index.min(new_siblings.len());
        new_siblings.insert(insert_at, request.node_id.clone());

        sqlx::query(
            "UPDATE nodes
             SET parent_id = ?1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?2",
        )
        .bind(request.new_parent_id.as_deref())
        .bind(&request.node_id)
        .execute(&mut *tx)
        .await
        .context("updating node parent")?;

        for (order_index, node_id) in old_siblings.iter().enumerate() {
            sqlx::query(
                "UPDATE nodes
                 SET order_index = ?1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?2",
            )
            .bind(order_index as i64)
            .bind(node_id)
            .execute(&mut *tx)
            .await
            .context("renumbering old sibling order after move")?;
        }

        for (order_index, node_id) in new_siblings.iter().enumerate() {
            sqlx::query(
                "UPDATE nodes
                 SET order_index = ?1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?2",
            )
            .bind(order_index as i64)
            .bind(node_id)
            .execute(&mut *tx)
            .await
            .context("renumbering new sibling order after move")?;
        }

        tx.commit().await.context("committing node move transaction")?;
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

    pub async fn get_ssh_known_host(&self, host: &str, port: i64) -> Result<Option<SshKnownHost>> {
        let row = sqlx::query(
            "SELECT host, port, key_type, public_key, created_at, updated_at, last_seen_at
             FROM ssh_known_hosts
             WHERE host = ?1 AND port = ?2",
        )
        .bind(host)
        .bind(port)
        .fetch_optional(&self.pool)
        .await
        .context("fetching ssh known host")?;

        let Some(row) = row else {
            return Ok(None);
        };

        Ok(Some(SshKnownHost {
            host: row.try_get("host")?,
            port: row.try_get("port")?,
            key_type: row.try_get("key_type")?,
            public_key: row.try_get("public_key")?,
            created_at: row.try_get("created_at")?,
            updated_at: row.try_get("updated_at")?,
            last_seen_at: row.try_get("last_seen_at")?,
        }))
    }

    pub async fn upsert_ssh_known_host(
        &self,
        host: &str,
        port: i64,
        key_type: &str,
        public_key: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO ssh_known_hosts (host, port, key_type, public_key, created_at, updated_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(host, port) DO UPDATE
             SET key_type = excluded.key_type,
                 public_key = excluded.public_key,
                 updated_at = CURRENT_TIMESTAMP,
                 last_seen_at = CURRENT_TIMESTAMP",
        )
        .bind(host)
        .bind(port)
        .bind(key_type)
        .bind(public_key)
        .execute(&self.pool)
        .await
        .context("upserting ssh known host")?;

        Ok(())
    }

    pub async fn touch_ssh_known_host_seen(&self, host: &str, port: i64) -> Result<()> {
        sqlx::query(
            "UPDATE ssh_known_hosts
             SET last_seen_at = CURRENT_TIMESTAMP
             WHERE host = ?1 AND port = ?2",
        )
        .bind(host)
        .bind(port)
        .execute(&self.pool)
        .await
        .context("updating ssh known host last_seen_at")?;

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
