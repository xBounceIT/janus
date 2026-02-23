/// Manually-defined COM interface for IMsTscNonScriptable.
///
/// The `windows` crate does not include the MsTscAx ActiveX control interfaces,
/// so we define the minimal interface needed to set the clear-text password.
use windows::core::{BSTR, GUID, HRESULT, IUnknown, Interface};
use windows::Win32::Foundation::{HWND, VARIANT_FALSE, VARIANT_TRUE};
use windows::Win32::System::Com::{IDispatch, IDispatch_Impl, IDispatch_Vtbl};
use windows_core::IUnknown_Vtbl;

/// IID for IMsTscAxEvents (event dispinterface)
pub const DIID_IMSTSC_AX_EVENTS: GUID =
    GUID::from_u128(0x336d5562_efa8_482e_8cb3_c5c0fc7a7db6);

/// COM dispinterface for MsTscAx ActiveX events.
///
/// This is a marker interface with the DIID that the connection point
/// uses to verify event sinks via QueryInterface. All event dispatching
/// goes through IDispatch::Invoke with DISPIDs, so no additional methods
/// are declared here.
#[windows::core::interface("336d5562-efa8-482e-8cb3-c5c0fc7a7db6")]
pub unsafe trait IMsTscAxEvents: IDispatch {}

/// COM interface for MsTscAx non-scriptable password access.
///
/// This interface is not currently exposed by the `windows` crate metadata,
/// so we define the minimal method surface we need locally.
#[windows::core::interface("c1e6743a-41c1-4a74-832a-0dd06c1c7a0e")]
pub unsafe trait IMsTscNonScriptable: IUnknown {
    fn put_clear_text_password(&self, bstr_password: &BSTR) -> HRESULT;
}

/// CLSIDs for MsRdpClient NotSafeForScripting classes (newest to oldest)
pub const CLSID_MSRDP_CLIENT_10: GUID =
    GUID::from_u128(0xa0c63c30_f08d_4ab4_907c_34905d770c7d);
pub const CLSID_MSRDP_CLIENT_9: GUID =
    GUID::from_u128(0x8b918b82_7985_4c24_89df_c33ad2bbfbcd);

/// Event DISPIDs for IMsTscAxEvents
pub const CYCLIC_DISPID_CONNECTING: i32 = 1;
pub const CYCLIC_DISPID_CONNECTED: i32 = 2;
pub const CYCLIC_DISPID_LOGIN_COMPLETE: i32 = 3;
pub const CYCLIC_DISPID_DISCONNECTED: i32 = 4;
pub const CYCLIC_DISPID_FATAL_ERROR: i32 = 10;
pub const CYCLIC_DISPID_WARNING: i32 = 11;
pub const CYCLIC_DISPID_LOGON_ERROR: i32 = 22;

/// Set the clear-text password via the IMsTscNonScriptable COM interface.
///
/// The `windows` crate does not include this ActiveX interface in generated bindings,
/// so we define a minimal local COM interface and call it via `cast()`.
pub unsafe fn set_clear_text_password(
    rdp_unknown: &IUnknown,
    password: &str,
) -> windows::core::Result<()> {
    let non_scriptable: IMsTscNonScriptable = rdp_unknown.cast()?;
    let bstr = BSTR::from(password);
    non_scriptable.put_clear_text_password(&bstr).ok()
}

/// IMsRdpClientNonScriptable3 COM interface for credential and dialog suppression.
///
/// Full vtable covering the inheritance chain:
///   IMsTscNonScriptable (10) → IMsRdpClientNonScriptable (2) →
///   IMsRdpClientNonScriptable2 (2) → IMsRdpClientNonScriptable3 (20)
///
/// Only methods we call have accurate signatures; the rest are placeholders
/// to maintain correct vtable offsets (34 methods total after IUnknown).
#[windows::core::interface("b3378d90-0728-45c7-8ed7-b6159fb92219")]
pub unsafe trait IMsRdpClientNonScriptable3: IUnknown {
    // --- IMsTscNonScriptable (10 methods, vtable slots 3–12) ---
    fn _ns_0(&self) -> HRESULT; // put_ClearTextPassword
    fn _ns_1(&self) -> HRESULT; // get_ClearTextPassword
    fn _ns_2(&self) -> HRESULT; // put_PortablePassword
    fn _ns_3(&self) -> HRESULT; // get_PortablePassword
    fn _ns_4(&self) -> HRESULT; // put_PortableSalt
    fn _ns_5(&self) -> HRESULT; // get_PortableSalt
    fn _ns_6(&self) -> HRESULT; // put_BinaryPassword
    fn _ns_7(&self) -> HRESULT; // get_BinaryPassword
    fn _ns_8(&self) -> HRESULT; // put_BinarySalt
    fn _ns_9(&self) -> HRESULT; // get_BinarySalt

    // --- IMsRdpClientNonScriptable (2 methods, vtable slots 13–14) ---
    fn _rdpns_0(&self) -> HRESULT; // NotifyRedirectDeviceChange
    fn _rdpns_1(&self) -> HRESULT; // SendKeys

    // --- IMsRdpClientNonScriptable2 (2 methods, vtable slots 15–16) ---
    fn put_ui_parent_window_handle(&self, hwnd: isize) -> HRESULT;
    fn _get_ui_parent_window_handle(&self) -> HRESULT;

    // --- IMsRdpClientNonScriptable3 own (20 methods, vtable slots 17–36) ---
    fn put_show_redirection_warning_dialog(&self, value: i16) -> HRESULT;
    fn _get_show_redirection_warning_dialog(&self) -> HRESULT;
    fn put_prompt_for_credentials(&self, value: i16) -> HRESULT;
    fn _get_prompt_for_credentials(&self) -> HRESULT;
    fn _put_negotiate_security_layer(&self) -> HRESULT;
    fn _get_negotiate_security_layer(&self) -> HRESULT;
    fn put_enable_cred_ssp_support(&self, value: i16) -> HRESULT;
    fn _get_enable_cred_ssp_support(&self) -> HRESULT;
    fn _ns3_0(&self) -> HRESULT; // put_RedirectDynamicDrives
    fn _ns3_1(&self) -> HRESULT; // get_RedirectDynamicDrives
    fn _ns3_2(&self) -> HRESULT; // put_RedirectDynamicDevices
    fn _ns3_3(&self) -> HRESULT; // get_RedirectDynamicDevices
    fn _ns3_4(&self) -> HRESULT;
    fn _ns3_5(&self) -> HRESULT;
    fn _ns3_6(&self) -> HRESULT;
    fn _ns3_7(&self) -> HRESULT;
    fn _ns3_8(&self) -> HRESULT;
    fn _ns3_9(&self) -> HRESULT;
    fn _ns3_10(&self) -> HRESULT;
    fn _ns3_11(&self) -> HRESULT;
}

/// Configure credential and dialog suppression via IMsRdpClientNonScriptable3.
///
/// This is best-effort: older RDP client versions may not support this
/// interface, so failures are logged as warnings but never propagated.
pub unsafe fn configure_non_scriptable3(
    rdp_unknown: &IUnknown,
    host_hwnd: HWND,
    has_password: bool,
) {
    let ns3: IMsRdpClientNonScriptable3 = match rdp_unknown.cast() {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("IMsRdpClientNonScriptable3 not available: {e}");
            return;
        }
    };

    // Suppress credential prompt when a password is already provided
    if has_password {
        let hr = ns3.put_prompt_for_credentials(VARIANT_FALSE.0);
        if hr.is_err() {
            tracing::warn!(hresult = format!("{:#010X}", hr.0 as u32), "failed to set PromptForCredentials");
        }
    }

    // Parent any dialogs to the host window
    let hr = ns3.put_ui_parent_window_handle(host_hwnd.0 as isize);
    if hr.is_err() {
        tracing::warn!(hresult = format!("{:#010X}", hr.0 as u32), "failed to set UIParentWindowHandle");
    }

    // Suppress redirection warning dialog
    let hr = ns3.put_show_redirection_warning_dialog(VARIANT_FALSE.0);
    if hr.is_err() {
        tracing::warn!(hresult = format!("{:#010X}", hr.0 as u32), "failed to set ShowRedirectionWarningDialog");
    }

    // Enable CredSSP support
    let hr = ns3.put_enable_cred_ssp_support(VARIANT_TRUE.0);
    if hr.is_err() {
        tracing::warn!(hresult = format!("{:#010X}", hr.0 as u32), "failed to set EnableCredSspSupport");
    }
}
