/// Dedicated STA (Single Threaded Apartment) thread for COM/ActiveX operations.
///
/// ActiveX controls require COM STA threading. This thread:
/// 1. Initializes COM in STA mode
/// 2. Runs a Win32 message pump (required for ActiveX controls)
/// 3. Processes RdpCommand requests from the async runtime
use std::collections::HashMap;
use std::sync::mpsc as std_mpsc;

use tokio::sync::{mpsc, oneshot};
use windows::core::{Interface, IUnknown};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetStockObject, HBRUSH, BLACK_BRUSH};
use windows::Win32::System::Com::{
    CoCreateInstance, IConnectionPointContainer, IDispatch, CLSCTX_INPROC_SERVER,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Ole::{
    IOleClientSite, IOleObject, OleInitialize, OleUninitialize, OLEIVERB_INPLACEACTIVATE,
    OLECLOSE_NOSAVE,
};
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::com_interfaces::*;
use crate::dispatch_helpers;
use crate::event_sink::RdpEventSink;
use crate::manager::{RdpActiveXEvent, RdpSessionConfig};
use crate::ole_container::OleContainer;
use crate::session::ActiveXSession;

/// Commands sent from the async runtime to the STA thread.
pub enum StaCommand {
    CreateSession {
        session_id: String,
        parent_hwnd: isize,
        config: RdpSessionConfig,
        event_tx: mpsc::UnboundedSender<RdpActiveXEvent>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Reposition {
        session_id: String,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    },
    Show {
        session_id: String,
    },
    Hide {
        session_id: String,
    },
    CloseSession {
        session_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Shutdown,
}

const HOST_WINDOW_CLASS: windows::core::PCWSTR = windows::core::w!("JanusRdpHost");

/// Entry point for the STA thread.
pub fn run_sta_thread(cmd_rx: std_mpsc::Receiver<StaCommand>) {
    unsafe {
        if let Err(e) = OleInitialize(None) {
            tracing::error!(?e, "OleInitialize failed");
            return;
        }

        register_host_window_class();

        let mut sessions: HashMap<String, ActiveXSession> = HashMap::new();

        loop {
            // Wait for either Win32 messages or channel commands
            // Use a tight polling loop with MsgWaitForMultipleObjects
            let _wait_result = MsgWaitForMultipleObjects(
                None,       // no handles
                false,      // wait all = false
                50,         // 50ms timeout for checking channel
                QS_ALLINPUT,
            );

            // Pump all pending Win32 messages
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT {
                    cleanup_all_sessions(&mut sessions);
                    OleUninitialize();
                    return;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            // Drain all pending commands from the channel
            loop {
                match cmd_rx.try_recv() {
                    Ok(cmd) => {
                        if matches!(cmd, StaCommand::Shutdown) {
                            cleanup_all_sessions(&mut sessions);
                            OleUninitialize();
                            return;
                        }
                        handle_command(cmd, &mut sessions);
                    }
                    Err(std_mpsc::TryRecvError::Empty) => break,
                    Err(std_mpsc::TryRecvError::Disconnected) => {
                        tracing::info!("STA command channel disconnected, shutting down");
                        cleanup_all_sessions(&mut sessions);
                        OleUninitialize();
                        return;
                    }
                }
            }
        }
    }
}

unsafe fn handle_command(cmd: StaCommand, sessions: &mut HashMap<String, ActiveXSession>) {
    match cmd {
        StaCommand::CreateSession {
            session_id,
            parent_hwnd,
            config,
            event_tx,
            reply,
        } => {
            let result = create_session(
                &session_id,
                HWND(parent_hwnd as *mut _),
                &config,
                event_tx,
                sessions,
            );
            let _ = reply.send(result.map_err(|e| format!("{e}")));
        }
        StaCommand::Reposition {
            session_id,
            x,
            y,
            width,
            height,
        } => {
            if let Some(session) = sessions.get(&session_id) {
                let _ = SetWindowPos(
                    session.host_hwnd,
                    Some(HWND_TOP),
                    x,
                    y,
                    width,
                    height,
                    SWP_SHOWWINDOW,
                );

                // Also resize the ActiveX control's in-place window
                resize_activex_control(session, width, height);
            }
        }
        StaCommand::Show { session_id } => {
            if let Some(session) = sessions.get(&session_id) {
                let _ = ShowWindow(session.host_hwnd, SW_SHOW);
                let _ = SetWindowPos(
                    session.host_hwnd,
                    Some(HWND_TOP),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
                );
            }
        }
        StaCommand::Hide { session_id } => {
            if let Some(session) = sessions.get(&session_id) {
                let _ = ShowWindow(session.host_hwnd, SW_HIDE);
            }
        }
        StaCommand::CloseSession { session_id, reply } => {
            let result = close_session(&session_id, sessions);
            let _ = reply.send(result.map_err(|e| format!("{e}")));
        }
        StaCommand::Shutdown => unreachable!("handled in caller"),
    }
}

unsafe fn create_session(
    session_id: &str,
    parent_hwnd: HWND,
    config: &RdpSessionConfig,
    event_tx: mpsc::UnboundedSender<RdpActiveXEvent>,
    sessions: &mut HashMap<String, ActiveXSession>,
) -> anyhow::Result<()> {
    tracing::info!(
        session_id,
        host = %config.host,
        port = config.port,
        "creating RDP ActiveX session"
    );

    // 1. Create host child window (initially hidden)
    let host_hwnd = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        HOST_WINDOW_CLASS,
        windows::core::w!(""),
        WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
        0,
        0,
        config.width.unwrap_or(1280) as i32,
        config.height.unwrap_or(720) as i32,
        Some(parent_hwnd),
        None,
        None,
        None,
    )?;

    // 2. Try to create the ActiveX control (newest version first)
    let rdp_unknown = try_create_rdp_control()?;

    // 3. Get IDispatch for property access
    let rdp_dispatch: IDispatch = rdp_unknown.cast()?;

    // 4. Set up OLE container and in-place activate
    let ole_object: IOleObject = rdp_unknown.cast()?;
    let container = OleContainer::new(host_hwnd);
    let client_site: IOleClientSite = container.into();
    ole_object.SetClientSite(&client_site)?;

    let mut rect = RECT::default();
    let _ = GetClientRect(host_hwnd, &mut rect);
    ole_object.DoVerb(
        OLEIVERB_INPLACEACTIVATE.0,
        core::ptr::null(),
        &client_site,
        0,
        host_hwnd,
        &rect,
    )?;

    tracing::debug!(session_id, "ActiveX control in-place activated");

    // 5. Configure the RDP connection properties
    configure_rdp_properties(&rdp_dispatch, config)?;

    // 6. Set password via IMsTscNonScriptable
    if let Some(password) = &config.password {
        if !password.is_empty() {
            set_clear_text_password(&rdp_unknown, password)?;
            tracing::debug!(session_id, "password injected via IMsTscNonScriptable");
        }
    }

    // 7. Connect event sink
    let mut session = ActiveXSession::new(
        host_hwnd,
        rdp_unknown.clone(),
        rdp_dispatch.clone(),
        config.clone(),
    );
    connect_event_sink(session_id, &rdp_unknown, event_tx, &mut session)?;

    // 8. Call Connect()
    dispatch_helpers::invoke_method(&rdp_dispatch, "Connect")?;
    tracing::info!(session_id, "RDP Connect() called");

    sessions.insert(session_id.to_string(), session);
    Ok(())
}

unsafe fn try_create_rdp_control() -> anyhow::Result<IUnknown> {
    // Try MsRdpClient10 first, fall back to 9
    let clsids = [CLSID_MSRDP_CLIENT_10, CLSID_MSRDP_CLIENT_9];

    for clsid in &clsids {
        match CoCreateInstance(clsid, None, CLSCTX_INPROC_SERVER) {
            Ok(unknown) => {
                tracing::info!(?clsid, "created MsRdpClient ActiveX control");
                return Ok(unknown);
            }
            Err(e) => {
                tracing::debug!(?clsid, ?e, "MsRdpClient CLSID not available, trying next");
            }
        }
    }

    anyhow::bail!(
        "RDP ActiveX control (MsTscAx) is not available on this system. \
         Ensure Remote Desktop Connection is installed."
    );
}

unsafe fn configure_rdp_properties(
    dispatch: &IDispatch,
    config: &RdpSessionConfig,
) -> anyhow::Result<()> {
    // Set server and port
    let server = if config.port != 3389 {
        format!("{}:{}", config.host, config.port)
    } else {
        config.host.clone()
    };
    dispatch_helpers::put_bstr_property(dispatch, "Server", &server)?;

    // Set username
    if let Some(username) = &config.username {
        if !username.is_empty() {
            dispatch_helpers::put_bstr_property(dispatch, "UserName", username)?;
        }
    }

    // Set domain
    if let Some(domain) = &config.domain {
        if !domain.is_empty() {
            dispatch_helpers::put_bstr_property(dispatch, "Domain", domain)?;
        }
    }

    // Set desktop size
    let width = config.width.unwrap_or(1280) as i32;
    let height = config.height.unwrap_or(720) as i32;
    dispatch_helpers::put_i32_property(dispatch, "DesktopWidth", width)?;
    dispatch_helpers::put_i32_property(dispatch, "DesktopHeight", height)?;

    // Get AdvancedSettings and configure
    if let Ok(adv) = dispatch_helpers::get_dispatch_property(dispatch, "AdvancedSettings") {
        // Enable NLA (Network Level Authentication)
        let _ = dispatch_helpers::put_bool_property(&adv, "EnableCredSspSupport", true);
        // Enable compression
        let _ = dispatch_helpers::put_i32_property(&adv, "Compress", 1);
        // Bitmap caching
        let _ = dispatch_helpers::put_i32_property(&adv, "BitmapPeristence", 1);
    }

    Ok(())
}

unsafe fn connect_event_sink(
    session_id: &str,
    rdp_unknown: &IUnknown,
    event_tx: mpsc::UnboundedSender<RdpActiveXEvent>,
    session: &mut ActiveXSession,
) -> anyhow::Result<()> {
    let cpc: IConnectionPointContainer = rdp_unknown.cast()?;
    let cp = cpc.FindConnectionPoint(&DIID_IMSTSC_AX_EVENTS)?;

    let sink = RdpEventSink::new(session_id.to_string(), event_tx);
    let dispatch: IDispatch = sink.into();
    let cookie = cp.Advise(&dispatch)?;

    session.connection_point = Some(cp);
    session.advise_cookie = cookie;

    tracing::debug!(session_id, cookie, "event sink connected");
    Ok(())
}

unsafe fn close_session(
    session_id: &str,
    sessions: &mut HashMap<String, ActiveXSession>,
) -> anyhow::Result<()> {
    let Some(session) = sessions.remove(session_id) else {
        anyhow::bail!("unknown RDP session: {session_id}");
    };

    tracing::info!(session_id, "closing RDP ActiveX session");

    // 1. Disconnect the RDP session
    let _ = dispatch_helpers::invoke_method(&session.rdp_dispatch, "Disconnect");

    // 2. Unadvise event sink
    if let Some(cp) = &session.connection_point {
        let _ = cp.Unadvise(session.advise_cookie);
    }

    // 3. Close the OLE object
    if let Ok(ole_object) = session.rdp_unknown.cast::<IOleObject>() {
        let _ = ole_object.Close(OLECLOSE_NOSAVE);
        let _ = ole_object.SetClientSite(None);
    }

    // 4. Destroy the host window
    let _ = DestroyWindow(session.host_hwnd);

    tracing::debug!(session_id, "RDP session cleaned up");
    Ok(())
}

unsafe fn cleanup_all_sessions(sessions: &mut HashMap<String, ActiveXSession>) {
    let ids: Vec<String> = sessions.keys().cloned().collect();
    for id in ids {
        let _ = close_session(&id, sessions);
    }
}

unsafe fn resize_activex_control(session: &ActiveXSession, width: i32, height: i32) {
    // Tell the OLE object about the new size
    if let Ok(ole_inplace) = session
        .rdp_unknown
        .cast::<windows::Win32::System::Ole::IOleInPlaceObject>()
    {
        let rect = RECT {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        };
        let _ = ole_inplace.SetObjectRects(&rect, &rect);
    }
}

unsafe fn register_host_window_class() {
    let wc = WNDCLASSEXW {
        cbSize: core::mem::size_of::<WNDCLASSEXW>() as u32,
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(host_wndproc),
        hInstance: GetModuleHandleW(None).unwrap_or_default().into(),
        lpszClassName: HOST_WINDOW_CLASS,
        hbrBackground: HBRUSH(GetStockObject(BLACK_BRUSH).0),
        ..Default::default()
    };
    RegisterClassExW(&wc);
}

unsafe extern "system" fn host_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    DefWindowProcW(hwnd, msg, wparam, lparam)
}
