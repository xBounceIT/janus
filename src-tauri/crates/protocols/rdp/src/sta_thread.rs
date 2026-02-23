/// Dedicated STA (Single Threaded Apartment) thread for COM/ActiveX operations.
///
/// ActiveX controls require COM STA threading. This thread:
/// 1. Initializes COM in STA mode
/// 2. Runs a Win32 message pump (required for ActiveX controls)
/// 3. Processes RdpCommand requests from the async runtime
use std::collections::HashMap;
use std::fmt;
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

#[derive(Debug, Clone)]
struct HostInitError {
    stage: &'static str,
    hresult: Option<i32>,
    message: String,
}

impl HostInitError {
    fn from_win(stage: &'static str, error: windows::core::Error) -> Self {
        Self {
            stage,
            hresult: Some(error.code().0),
            message: error.to_string(),
        }
    }

    fn message(stage: &'static str, message: impl Into<String>) -> Self {
        Self {
            stage,
            hresult: None,
            message: message.into(),
        }
    }

    fn hresult_hex(&self) -> Option<String> {
        self.hresult.map(|hr| format!("{:#010X}", hr as u32))
    }
}

impl fmt::Display for HostInitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(hr) = self.hresult_hex() {
            write!(
                f,
                "RDP host initialization failed at '{}' ({hr}): {}",
                self.stage, self.message
            )
        } else {
            write!(
                f,
                "RDP host initialization failed at '{}': {}",
                self.stage, self.message
            )
        }
    }
}

impl std::error::Error for HostInitError {}

struct SessionCreateGuard {
    session_id: String,
    host_hwnd: HWND,
    rdp_unknown: Option<IUnknown>,
    client_site_set: bool,
    armed: bool,
}

impl SessionCreateGuard {
    fn new(session_id: &str, host_hwnd: HWND) -> Self {
        Self {
            session_id: session_id.to_string(),
            host_hwnd,
            rdp_unknown: None,
            client_site_set: false,
            armed: true,
        }
    }

    fn track_control(&mut self, rdp_unknown: &IUnknown) {
        self.rdp_unknown = Some(rdp_unknown.clone());
    }

    fn mark_client_site_set(&mut self) {
        self.client_site_set = true;
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for SessionCreateGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }

        unsafe {
            tracing::warn!(
                session_id = %self.session_id,
                host_hwnd = ?self.host_hwnd,
                "cleaning up partially initialized RDP host resources"
            );

            if self.client_site_set {
                if let Some(rdp_unknown) = &self.rdp_unknown {
                    if let Ok(ole_object) = rdp_unknown.cast::<IOleObject>() {
                        let _ = ole_object.Close(OLECLOSE_NOSAVE);
                        let _ = ole_object.SetClientSite(None);
                    }
                }
            }

            let _ = DestroyWindow(self.host_hwnd);
        }
    }
}

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
            let error_event_tx = event_tx.clone();
            let result = create_session(
                &session_id,
                HWND(parent_hwnd as *mut _),
                &config,
                event_tx,
                sessions,
            );
            if let Err(error) = &result {
                tracing::error!(
                    session_id = %session_id,
                    stage = error.stage,
                    hresult = ?error.hresult_hex(),
                    message = %error.message,
                    "RDP host initialization failed"
                );
                let _ = error_event_tx.send(RdpActiveXEvent::HostInitFailed {
                    session_id: session_id.clone(),
                    stage: error.stage.to_string(),
                    hresult: error.hresult,
                    message: error.message.clone(),
                });
            }
            let _ = reply.send(result.map_err(|e| e.to_string()));
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
) -> Result<(), HostInitError> {
    tracing::info!(
        session_id,
        host = %config.host,
        port = config.port,
        parent_hwnd = ?parent_hwnd,
        thread_id = ?std::thread::current().id(),
        "creating RDP ActiveX session"
    );

    // 1. Create host child window (initially hidden)
    tracing::debug!(session_id, stage = "create_host_window", "RDP host init stage start");
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
    )
    .map_err(|e| HostInitError::from_win("create_host_window", e))?;
    tracing::debug!(
        session_id,
        stage = "create_host_window",
        host_hwnd = ?host_hwnd,
        "RDP host init stage complete"
    );
    let mut guard = SessionCreateGuard::new(session_id, host_hwnd);

    // 2. Try to create the ActiveX control (newest version first)
    tracing::debug!(session_id, stage = "co_create_activex", "RDP host init stage start");
    let rdp_unknown = try_create_rdp_control()?;
    guard.track_control(&rdp_unknown);
    tracing::debug!(session_id, stage = "co_create_activex", "RDP host init stage complete");

    // 3. Get IDispatch for property access
    tracing::debug!(session_id, stage = "cast_idispatch", "RDP host init stage start");
    let rdp_dispatch: IDispatch = rdp_unknown
        .cast()
        .map_err(|e| HostInitError::from_win("cast_idispatch", e))?;
    tracing::debug!(session_id, stage = "cast_idispatch", "RDP host init stage complete");

    // 4. Set up OLE container and in-place activate
    tracing::debug!(session_id, stage = "cast_ole_object", "RDP host init stage start");
    let ole_object: IOleObject = rdp_unknown
        .cast()
        .map_err(|e| HostInitError::from_win("cast_ole_object", e))?;
    tracing::debug!(session_id, stage = "cast_ole_object", "RDP host init stage complete");
    let container = OleContainer::new(host_hwnd);
    let client_site: IOleClientSite = container.into();
    tracing::debug!(session_id, stage = "set_client_site", "RDP host init stage start");
    ole_object
        .SetClientSite(&client_site)
        .map_err(|e| HostInitError::from_win("set_client_site", e))?;
    guard.mark_client_site_set();
    tracing::debug!(session_id, stage = "set_client_site", "RDP host init stage complete");

    let mut rect = RECT::default();
    let _ = GetClientRect(host_hwnd, &mut rect);
    tracing::debug!(session_id, stage = "do_verb_inplace_activate", "RDP host init stage start");
    ole_object
        .DoVerb(
            OLEIVERB_INPLACEACTIVATE.0,
            core::ptr::null(),
            &client_site,
            0,
            host_hwnd,
            &rect,
        )
        .map_err(|e| HostInitError::from_win("do_verb_inplace_activate", e))?;
    tracing::debug!(
        session_id,
        stage = "do_verb_inplace_activate",
        "RDP host init stage complete"
    );

    // 5. Configure the RDP connection properties
    tracing::debug!(session_id, stage = "configure_properties", "RDP host init stage start");
    configure_rdp_properties(&rdp_dispatch, config)
        .map_err(|e| HostInitError::from_win("configure_properties", e))?;
    tracing::debug!(session_id, stage = "configure_properties", "RDP host init stage complete");

    // 6. Set password via IMsTscNonScriptable
    if let Some(password) = &config.password {
        if !password.is_empty() {
            tracing::debug!(session_id, stage = "set_password", "RDP host init stage start");
            set_clear_text_password(&rdp_unknown, password)
                .map_err(|e| HostInitError::from_win("set_password", e))?;
            tracing::debug!(session_id, stage = "set_password", "RDP host init stage complete");
            tracing::debug!(session_id, "password injected via IMsTscNonScriptable");
        }
    }

    // 6.5. Configure credential/dialog suppression via NonScriptable3
    let suppress_credential_prompt = crate::should_suppress_rdp_credential_prompt(
        config.username.as_deref(),
        config.password.as_deref(),
    );
    tracing::debug!(session_id, stage = "configure_non_scriptable3", "RDP host init stage start");
    configure_non_scriptable3(&rdp_unknown, host_hwnd, suppress_credential_prompt);
    tracing::debug!(session_id, stage = "configure_non_scriptable3", "RDP host init stage complete");

    // 7. Connect event sink
    let mut session = ActiveXSession::new(
        host_hwnd,
        rdp_unknown.clone(),
        rdp_dispatch.clone(),
    );
    session.client_site = Some(client_site);
    tracing::debug!(session_id, stage = "connect_event_sink", "RDP host init stage start");
    connect_event_sink(session_id, &rdp_unknown, event_tx, &mut session)
        .map_err(|e| HostInitError::from_win("connect_event_sink", e))?;
    tracing::debug!(session_id, stage = "connect_event_sink", "RDP host init stage complete");

    // 8. Call Connect()
    tracing::debug!(session_id, stage = "connect_call", "RDP host init stage start");
    dispatch_helpers::invoke_method(&rdp_dispatch, "Connect")
        .map_err(|e| HostInitError::from_win("connect_call", e))?;
    tracing::debug!(session_id, stage = "connect_call", "RDP host init stage complete");
    tracing::info!(session_id, "RDP Connect() called");

    sessions.insert(session_id.to_string(), session);
    guard.disarm();
    Ok(())
}

unsafe fn try_create_rdp_control() -> Result<IUnknown, HostInitError> {
    // Try MsRdpClient10 first, fall back to 9
    let clsids = [CLSID_MSRDP_CLIENT_10, CLSID_MSRDP_CLIENT_9];
    let mut last_error: Option<windows::core::Error> = None;

    for clsid in &clsids {
        match CoCreateInstance(clsid, None, CLSCTX_INPROC_SERVER) {
            Ok(unknown) => {
                tracing::info!(?clsid, "created MsRdpClient ActiveX control");
                return Ok(unknown);
            }
            Err(e) => {
                tracing::debug!(
                    ?clsid,
                    hresult = format!("{:#010X}", e.code().0 as u32),
                    ?e,
                    "MsRdpClient CLSID not available, trying next"
                );
                last_error = Some(e);
            }
        }
    }

    if let Some(error) = last_error {
        return Err(HostInitError::from_win("co_create_activex", error));
    }

    Err(HostInitError::message(
        "co_create_activex",
        "RDP ActiveX control (MsTscAx) is not available on this system. Ensure Remote Desktop Connection is installed.",
    ))
}

unsafe fn configure_rdp_properties(
    dispatch: &IDispatch,
    config: &RdpSessionConfig,
) -> windows::core::Result<()> {
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
        if let Err(e) = dispatch_helpers::put_bool_property(&adv, "EnableCredSspSupport", true) {
            tracing::warn!("failed to set EnableCredSspSupport: {e}");
        }
        // Suppress server authentication dialog
        if let Err(e) = dispatch_helpers::put_i32_property(&adv, "AuthenticationLevel", 0) {
            tracing::warn!("failed to set AuthenticationLevel: {e}");
        }
        // Enable compression
        if let Err(e) = dispatch_helpers::put_i32_property(&adv, "Compress", 1) {
            tracing::warn!("failed to set Compress: {e}");
        }
        // Bitmap caching
        if let Err(e) = dispatch_helpers::put_i32_property(&adv, "BitmapPeristence", 1) {
            tracing::warn!("failed to set BitmapPeristence: {e}");
        }
    }

    Ok(())
}

unsafe fn connect_event_sink(
    session_id: &str,
    rdp_unknown: &IUnknown,
    event_tx: mpsc::UnboundedSender<RdpActiveXEvent>,
    session: &mut ActiveXSession,
) -> windows::core::Result<()> {
    let cpc: IConnectionPointContainer = rdp_unknown.cast()?;
    let cp = cpc.FindConnectionPoint(&DIID_IMSTSC_AX_EVENTS)?;

    let sink = RdpEventSink::new(session_id.to_string(), event_tx);
    let events: IMsTscAxEvents = sink.into();
    let unknown = IUnknown::from(events);
    let cookie = cp.Advise(&unknown)?;

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
