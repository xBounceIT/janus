/// Manually-defined COM interface for IMsTscNonScriptable.
///
/// The `windows` crate does not include the MsTscAx ActiveX control interfaces,
/// so we define the minimal interface needed to set the clear-text password.
use windows::core::{BSTR, GUID, HRESULT, IUnknown, Interface};
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
