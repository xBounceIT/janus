/// Manually-defined COM interface for IMsTscNonScriptable.
///
/// The `windows` crate does not include the MsTscAx ActiveX control interfaces,
/// so we define the minimal interface needed to set the clear-text password.
use windows::core::{BSTR, GUID, HRESULT, IUnknown, Interface};
use windows::Win32::System::Com::{IDispatch, IDispatch_Impl, IDispatch_Vtbl};

/// IID for IMsTscNonScriptable
pub const IID_IMSTSC_NON_SCRIPTABLE: GUID =
    GUID::from_u128(0xc1e6743a_41c1_4a74_832a_0dd06c1c7a0e);

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
/// We use raw vtable access because this interface is not in the `windows` crate.
/// The IMsTscNonScriptable vtable (after IUnknown's 3 methods):
///   [3] put_ClearTextPassword(BSTR)
///   [4] get_ClearTextPassword(*mut BSTR)
///   ... (remaining methods not needed)
pub unsafe fn set_clear_text_password(
    rdp_unknown: &IUnknown,
    password: &str,
) -> windows::core::Result<()> {
    // QueryInterface for IMsTscNonScriptable
    let mut non_scriptable: *mut core::ffi::c_void = core::ptr::null_mut();
    rdp_unknown
        .query(&IID_IMSTSC_NON_SCRIPTABLE, &mut non_scriptable)
        .ok()?;

    if non_scriptable.is_null() {
        return Err(windows::core::Error::new(
            HRESULT(-1),
            "IMsTscNonScriptable query returned null",
        ));
    }

    // Read the vtable pointer (first pointer-sized value at the interface pointer)
    let vtable = *(non_scriptable as *const *const *const core::ffi::c_void);

    // Method at vtable index 3 is put_ClearTextPassword(BSTR)
    let put_password: unsafe extern "system" fn(
        this: *mut core::ffi::c_void,
        bstr_password: *const u16,
    ) -> HRESULT = core::mem::transmute(*vtable.add(3));

    let bstr = BSTR::from(password);
    let hr = put_password(non_scriptable, bstr.as_ptr());

    // Release the interface (call Release at vtable index 2)
    let release: unsafe extern "system" fn(*mut core::ffi::c_void) -> u32 =
        core::mem::transmute(*vtable.add(2));
    release(non_scriptable);

    hr.ok()
}
