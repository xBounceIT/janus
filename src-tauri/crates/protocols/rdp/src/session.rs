/// Per-session ActiveX state.
///
/// Each RDP session owns a host HWND and the COM objects for the ActiveX control.
/// All fields are only accessed from the STA thread.
use windows::core::IUnknown;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{IConnectionPoint, IDispatch};
use windows::Win32::System::Ole::IOleClientSite;

pub struct ActiveXSession {
    /// The child HWND hosting the ActiveX control
    pub host_hwnd: HWND,
    /// IUnknown root of the ActiveX control (used for QueryInterface)
    pub rdp_unknown: IUnknown,
    /// IDispatch for property access and method calls
    pub rdp_dispatch: IDispatch,
    /// Connection point for event unadvise on cleanup
    pub connection_point: Option<IConnectionPoint>,
    /// Cookie from Advise() for Unadvise()
    pub advise_cookie: u32,
    /// Client site retained for the lifetime of the hosted control
    pub client_site: Option<IOleClientSite>,
}

impl ActiveXSession {
    pub fn new(
        host_hwnd: HWND,
        rdp_unknown: IUnknown,
        rdp_dispatch: IDispatch,
    ) -> Self {
        Self {
            host_hwnd,
            rdp_unknown,
            rdp_dispatch,
            connection_point: None,
            advise_cookie: 0,
            client_site: None,
        }
    }
}
