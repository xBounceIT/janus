use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use tokio::process::Command;

#[derive(Debug, Clone)]
pub struct RdpLaunchConfig {
    pub host: String,
    pub port: i64,
    pub username: Option<String>,
    pub domain: Option<String>,
    pub screen_mode: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub password: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RdpLaunchResult {
    pub profile_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct RdpLauncher;

impl RdpLauncher {
    pub fn new() -> Self {
        Self
    }

    pub async fn launch(&self, config: &RdpLaunchConfig) -> Result<RdpLaunchResult> {
        #[cfg(not(target_os = "windows"))]
        {
            let _ = config;
            return Err(anyhow!("RDP launch is only supported on Windows"));
        }

        #[cfg(target_os = "windows")]
        {
            let profile_path = create_rdp_file(config).await?;
            let target = format!("TERMSRV/{}", config.host);

            if let (Some(username), Some(password)) = (&config.username, &config.password) {
                inject_credentials(&target, username, config.domain.as_deref(), password).await?;
            }

            Command::new("mstsc.exe")
                .arg(&profile_path)
                .spawn()
                .context("launching mstsc.exe")?;

            let cleanup_target = target.clone();
            let cleanup_profile = profile_path.clone();
            if config.password.is_some() {
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(8)).await;
                    let _ = remove_credentials(&cleanup_target).await;
                    let _ = tokio::fs::remove_file(cleanup_profile).await;
                });
            } else {
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(8)).await;
                    let _ = tokio::fs::remove_file(cleanup_profile).await;
                });
            }

            Ok(RdpLaunchResult { profile_path })
        }
    }
}

impl Default for RdpLauncher {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_os = "windows")]
async fn create_rdp_file(config: &RdpLaunchConfig) -> Result<PathBuf> {
    let file_path = std::env::temp_dir().join(format!("janus-{}.rdp", uuid::Uuid::new_v4()));

    let width = config.width.unwrap_or(1600);
    let height = config.height.unwrap_or(900);

    let mut body = String::new();
    body.push_str(&format!("full address:s:{}\n", config.host));
    body.push_str(&format!("server port:i:{}\n", config.port));
    body.push_str(&format!("screen mode id:i:{}\n", config.screen_mode));
    body.push_str(&format!("desktopwidth:i:{}\n", width));
    body.push_str(&format!("desktopheight:i:{}\n", height));

    if let Some(username) = &config.username {
        if let Some(domain) = &config.domain {
            body.push_str(&format!("username:s:{}\\{}\n", domain, username));
        } else {
            body.push_str(&format!("username:s:{}\n", username));
        }
    }

    tokio::fs::write(&file_path, body)
        .await
        .with_context(|| format!("writing RDP profile {}", file_path.display()))?;

    Ok(file_path)
}

#[cfg(target_os = "windows")]
async fn inject_credentials(
    target: &str,
    username: &str,
    domain: Option<&str>,
    password: &str,
) -> Result<()> {
    let user_value = if let Some(domain) = domain {
        format!("{}\\{}", domain, username)
    } else {
        username.to_string()
    };

    let status = Command::new("cmdkey")
        .arg(format!("/generic:{target}"))
        .arg(format!("/user:{user_value}"))
        .arg(format!("/pass:{password}"))
        .status()
        .await
        .context("running cmdkey for temporary RDP credential")?;

    if !status.success() {
        return Err(anyhow!("cmdkey failed to inject temporary credential"));
    }

    Ok(())
}

#[cfg(target_os = "windows")]
async fn remove_credentials(target: &str) -> Result<()> {
    let status = Command::new("cmdkey")
        .arg(format!("/delete:{target}"))
        .status()
        .await
        .context("running cmdkey cleanup")?;

    if !status.success() {
        return Err(anyhow!("cmdkey failed to remove temporary credential"));
    }

    Ok(())
}
