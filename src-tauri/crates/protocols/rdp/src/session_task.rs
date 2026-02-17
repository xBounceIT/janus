use std::net::SocketAddr;

use anyhow::{anyhow, Context};
use ironrdp_connector::sspi::generator::NetworkRequest;
use ironrdp_connector::{ClientConnector, Config, Credentials, DesktopSize, ServerName};
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_input::Database as InputDatabase;
use ironrdp_pdu::gcc::KeyboardType;
use ironrdp_pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp_pdu::rdp::client_info::{PerformanceFlags, TimezoneInfo};
use ironrdp_pdu::Action;
use ironrdp_session::image::DecodedImage;
use ironrdp_session::{ActiveStage, ActiveStageOutput};
use ironrdp_tokio::{connect_begin, connect_finalize, mark_as_upgraded, TokioFramed};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::frame_encode;
use crate::input;
use crate::session_manager::{RdpEvent, RdpSessionConfig, SessionCommand};

const FRAME_INTERVAL_MS: u64 = 33; // ~30 FPS
const JPEG_QUALITY: u8 = 80;

/// No-op network client — we don't support CredSSP/NLA in MVP.
struct NoNetworkClient;

impl ironrdp_tokio::NetworkClient for NoNetworkClient {
    fn send(
        &mut self,
        _network_request: &NetworkRequest,
    ) -> impl std::future::Future<Output = ironrdp_connector::ConnectorResult<Vec<u8>>> {
        std::future::ready(Err(ironrdp_connector::general_err!(
            "NLA/CredSSP not supported in this build"
        )))
    }
}

pub(crate) async fn run_session(
    config: RdpSessionConfig,
    event_tx: mpsc::UnboundedSender<RdpEvent>,
    mut cmd_rx: mpsc::UnboundedReceiver<SessionCommand>,
) {
    if let Err(e) = run_session_inner(&config, &event_tx, &mut cmd_rx).await {
        tracing::error!("RDP session error: {e:#}");
        let _ = event_tx.send(RdpEvent::Exit {
            reason: format!("{e:#}"),
        });
    }
}

async fn run_session_inner(
    config: &RdpSessionConfig,
    event_tx: &mpsc::UnboundedSender<RdpEvent>,
    cmd_rx: &mut mpsc::UnboundedReceiver<SessionCommand>,
) -> anyhow::Result<()> {
    let addr = format!("{}:{}", config.host, config.port);

    // 1. TCP connect with timeout
    let tcp_stream = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        TcpStream::connect(&addr),
    )
    .await
    .map_err(|_| anyhow!("RDP connection timed out after 10s"))?
    .context("TCP connection failed")?;

    let client_addr: SocketAddr = tcp_stream
        .local_addr()
        .unwrap_or_else(|_| "0.0.0.0:0".parse().unwrap());

    // 2. Build ironrdp connector config
    let rdp_config = Config {
        desktop_size: DesktopSize {
            width: config.width,
            height: config.height,
        },
        credentials: Credentials::UsernamePassword {
            username: config.username.clone(),
            password: config.password.clone(),
        },
        domain: config.domain.clone(),
        enable_tls: true,
        enable_credssp: false,
        client_build: 0,
        client_name: "Janus".to_string(),
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_functional_keys_count: 12,
        keyboard_layout: 0x0409, // US English
        ime_file_name: String::new(),
        bitmap: None,
        dig_product_id: String::new(),
        client_dir: "C:\\Windows\\System32\\mstsc.exe".to_string(),
        platform: MajorPlatformType::WINDOWS,
        hardware_id: None,
        request_data: None,
        autologon: true,
        desktop_scale_factor: 0,
        enable_audio_playback: false,
        performance_flags: PerformanceFlags::default(),
        license_cache: None,
        timezone_info: TimezoneInfo::default(),
        enable_server_pointer: false,
        pointer_software_rendering: false,
    };

    let mut connector = ClientConnector::new(rdp_config, client_addr);

    // 3. Wrap TCP stream in framed transport and begin connection
    let mut framed = TokioFramed::new(tcp_stream);

    let should_upgrade = connect_begin(&mut framed, &mut connector)
        .await
        .map_err(|e| anyhow!("RDP connect_begin failed: {e}"))?;

    // 4. TLS upgrade (required — we set enable_tls: true)
    if !connector.should_perform_security_upgrade() {
        return Err(anyhow!("Server did not request TLS upgrade"));
    }

    let (tcp, leftover) = framed.into_inner();
    let tls_stream = crate::tls::upgrade(tcp, &config.host).await?;
    let mut framed = TokioFramed::new_with_leftover(tls_stream, leftover);

    let upgraded = mark_as_upgraded(should_upgrade, &mut connector);

    // 5. Finalize connection
    let mut no_net = NoNetworkClient;
    let server_name = ServerName::new(&config.host);
    let server_public_key = Vec::new();

    let connection_result = connect_finalize(
        upgraded,
        connector,
        &mut framed,
        &mut no_net,
        server_name,
        server_public_key,
        None,
    )
    .await
    .map_err(|e| anyhow!("RDP connect_finalize failed: {e}"))?;

    tracing::info!(
        width = connection_result.desktop_size.width,
        height = connection_result.desktop_size.height,
        "RDP connection established"
    );

    // 6. Extract raw stream from framed for the active session loop
    let width = connection_result.desktop_size.width;
    let height = connection_result.desktop_size.height;
    let mut image = DecodedImage::new(PixelFormat::BgrA32, width, height);
    let mut stage = ActiveStage::new(connection_result);
    let mut input_db = InputDatabase::new();

    let (raw_stream, leftover) = framed.into_inner();
    let (mut rd, mut wr) = tokio::io::split(raw_stream);

    let mut buf = leftover;
    let mut last_frame_time = Instant::now();
    let mut dirty = false;

    // 7. Main loop
    loop {
        tokio::select! {
            // Read from server
            read_result = rd.read_buf(&mut buf) => {
                let n = read_result.context("RDP read error")?;
                if n == 0 {
                    let _ = event_tx.send(RdpEvent::Exit {
                        reason: "Server closed connection".to_string(),
                    });
                    return Ok(());
                }

                // Process all complete PDUs in the buffer
                while let Some((action, size)) = find_pdu_size(&buf) {
                    let frame_bytes = buf.split_to(size);
                    match stage.process(&mut image, action, &frame_bytes) {
                        Ok(outputs) => {
                            for output in outputs {
                                match output {
                                    ActiveStageOutput::ResponseFrame(bytes) => {
                                        wr.write_all(&bytes).await.context("RDP write error")?;
                                        wr.flush().await.context("RDP flush error")?;
                                    }
                                    ActiveStageOutput::GraphicsUpdate(_) => {
                                        dirty = true;
                                    }
                                    ActiveStageOutput::Terminate(reason) => {
                                        let _ = event_tx.send(RdpEvent::Exit {
                                            reason: format!("Server disconnected: {reason:?}"),
                                        });
                                        return Ok(());
                                    }
                                    ActiveStageOutput::DeactivateAll(_) => {
                                        let _ = event_tx.send(RdpEvent::Exit {
                                            reason: "Server requested deactivation".to_string(),
                                        });
                                        return Ok(());
                                    }
                                    _ => {}
                                }
                            }
                        }
                        Err(e) => {
                            let _ = event_tx.send(RdpEvent::Exit {
                                reason: format!("RDP processing error: {e}"),
                            });
                            return Ok(());
                        }
                    }
                }

                // Emit frame if dirty and enough time has elapsed
                if dirty && last_frame_time.elapsed().as_millis() >= FRAME_INTERVAL_MS as u128 {
                    if let Some(jpeg_data) = frame_encode::encode_jpeg(&image, JPEG_QUALITY) {
                        let _ = event_tx.send(RdpEvent::Frame { data: jpeg_data });
                    }
                    dirty = false;
                    last_frame_time = Instant::now();
                }
            }

            // Process commands from frontend
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(SessionCommand::MouseEvent { x, y, buttons, prev_buttons, wheel_delta }) => {
                        let ops = input::translate_mouse(x, y, buttons, prev_buttons, wheel_delta);
                        let events = input_db.apply(ops);
                        if let Ok(outputs) = stage.process_fastpath_input(&mut image, &events) {
                            for output in outputs {
                                if let ActiveStageOutput::ResponseFrame(bytes) = output {
                                    if let Err(e) = wr.write_all(&bytes).await {
                                        tracing::debug!("RDP write error on input: {e}");
                                        return Ok(());
                                    }
                                    let _ = wr.flush().await;
                                }
                            }
                        }
                    }
                    Some(SessionCommand::KeyEvent { scancode, extended, is_release }) => {
                        let op = input::translate_key(scancode, extended, is_release);
                        let events = input_db.apply([op]);
                        if let Ok(outputs) = stage.process_fastpath_input(&mut image, &events) {
                            for output in outputs {
                                if let ActiveStageOutput::ResponseFrame(bytes) = output {
                                    if let Err(e) = wr.write_all(&bytes).await {
                                        tracing::debug!("RDP write error on key input: {e}");
                                        return Ok(());
                                    }
                                    let _ = wr.flush().await;
                                }
                            }
                        }
                    }
                    Some(SessionCommand::Close) | None => {
                        let _ = event_tx.send(RdpEvent::Exit {
                            reason: "Session closed by user".to_string(),
                        });
                        return Ok(());
                    }
                }
            }
        }
    }
}

/// Parse the size of the next complete RDP PDU in the buffer.
/// Returns `None` if the buffer doesn't contain a complete PDU.
fn find_pdu_size(buf: &[u8]) -> Option<(Action, usize)> {
    if buf.len() < 2 {
        return None;
    }

    if buf[0] == 0x03 {
        // TPKT (X224): byte 0 = 0x03, bytes 2-3 = big-endian 16-bit length
        if buf.len() < 4 {
            return None;
        }
        let length = u16::from_be_bytes([buf[2], buf[3]]) as usize;
        if length == 0 || buf.len() < length {
            return None;
        }
        Some((Action::X224, length))
    } else {
        // FastPath: byte 0 != 0x03
        if buf[1] & 0x80 == 0 {
            // Single-byte length
            let length = buf[1] as usize;
            if length == 0 || buf.len() < length {
                return None;
            }
            Some((Action::FastPath, length))
        } else {
            // Two-byte length
            if buf.len() < 3 {
                return None;
            }
            let length = (((buf[1] & 0x7F) as usize) << 8) | (buf[2] as usize);
            if length == 0 || buf.len() < length {
                return None;
            }
            Some((Action::FastPath, length))
        }
    }
}
