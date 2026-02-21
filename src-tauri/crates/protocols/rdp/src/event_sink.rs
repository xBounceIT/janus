/// IDispatch-based event sink for IMsTscAxEvents.
///
/// Receives RDP ActiveX control events (OnConnected, OnDisconnected, etc.)
/// and forwards them through an mpsc channel to the async runtime.
use std::panic::{catch_unwind, AssertUnwindSafe};

use tokio::sync::mpsc;
use windows::core::{implement, Error, GUID, HRESULT};
use windows::Win32::System::Com::{
    DISPATCH_FLAGS, DISPPARAMS, IDispatch, IDispatch_Impl, ITypeInfo,
};
use windows::Win32::System::Variant::{VARIANT, VT_I4};

use crate::com_interfaces::*;
use crate::manager::RdpActiveXEvent;

const E_FAIL_HR: HRESULT = HRESULT(0x80004005u32 as i32);
const E_NOTIMPL_HR: HRESULT = HRESULT(0x80004001u32 as i32);

#[derive(Debug)]
#[implement(IDispatch)]
pub struct RdpEventSink {
    session_id: String,
    event_tx: mpsc::UnboundedSender<RdpActiveXEvent>,
}

impl RdpEventSink {
    pub fn new(
        session_id: String,
        event_tx: mpsc::UnboundedSender<RdpActiveXEvent>,
    ) -> Self {
        Self {
            session_id,
            event_tx,
        }
    }

    fn send(&self, event: RdpActiveXEvent) {
        let _ = self.event_tx.send(event);
    }
}

impl IDispatch_Impl for RdpEventSink_Impl {
    fn GetTypeInfoCount(&self) -> windows::core::Result<u32> {
        Ok(0)
    }

    fn GetTypeInfo(&self, _itinfo: u32, _lcid: u32) -> windows::core::Result<ITypeInfo> {
        Err(Error::from(E_NOTIMPL_HR))
    }

    fn GetIDsOfNames(
        &self,
        _riid: *const GUID,
        _rgsznames: *const windows::core::PCWSTR,
        _cnames: u32,
        _lcid: u32,
        _rgdispid: *mut i32,
    ) -> windows::core::Result<()> {
        Err(Error::new(HRESULT(0x80020006u32 as i32), "")) // DISP_E_UNKNOWNNAME
    }

    fn Invoke(
        &self,
        dispidmember: i32,
        _riid: *const GUID,
        _lcid: u32,
        _wflags: DISPATCH_FLAGS,
        pdispparams: *const DISPPARAMS,
        _pvarresult: *mut VARIANT,
        _pexcepinfo: *mut windows::Win32::System::Com::EXCEPINFO,
        _puargerr: *mut u32,
    ) -> windows::core::Result<()> {
        catch_unwind_com("RdpEventSink::Invoke", || {
            let sid = self.session_id.clone();

            match dispidmember {
                CYCLIC_DISPID_CONNECTING => {
                    tracing::debug!(session_id = %sid, "RDP event: OnConnecting");
                    self.send(RdpActiveXEvent::Connecting { session_id: sid });
                }
                CYCLIC_DISPID_CONNECTED => {
                    tracing::debug!(session_id = %sid, "RDP event: OnConnected");
                    self.send(RdpActiveXEvent::Connected { session_id: sid });
                }
                CYCLIC_DISPID_LOGIN_COMPLETE => {
                    tracing::debug!(session_id = %sid, "RDP event: OnLoginComplete");
                    self.send(RdpActiveXEvent::LoginComplete { session_id: sid });
                }
                CYCLIC_DISPID_DISCONNECTED => {
                    let reason = unsafe { extract_i32_arg(pdispparams, 0) }.unwrap_or(0);
                    tracing::debug!(session_id = %sid, reason, "RDP event: OnDisconnected");
                    self.send(RdpActiveXEvent::Disconnected {
                        session_id: sid,
                        reason,
                    });
                }
                CYCLIC_DISPID_FATAL_ERROR => {
                    let error_code = unsafe { extract_i32_arg(pdispparams, 0) }.unwrap_or(-1);
                    tracing::error!(session_id = %sid, error_code, "RDP event: OnFatalError");
                    self.send(RdpActiveXEvent::FatalError {
                        session_id: sid,
                        error_code,
                    });
                }
                CYCLIC_DISPID_WARNING => {
                    let warning_code = unsafe { extract_i32_arg(pdispparams, 0) }.unwrap_or(0);
                    tracing::warn!(session_id = %sid, warning_code, "RDP event: OnWarning");
                }
                CYCLIC_DISPID_LOGON_ERROR => {
                    let error_code = unsafe { extract_i32_arg(pdispparams, 0) }.unwrap_or(0);
                    tracing::warn!(session_id = %sid, error_code, "RDP event: OnLogonError");
                }
                _ => {
                    tracing::trace!(session_id = %sid, dispidmember, "RDP event: unhandled DISPID");
                }
            }

            Ok(())
        })
    }
}

fn catch_unwind_com<T>(
    context: &'static str,
    f: impl FnOnce() -> windows::core::Result<T>,
) -> windows::core::Result<T> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(result) => result,
        Err(_) => {
            tracing::error!(context, "panic prevented from crossing COM callback boundary");
            Err(Error::from(E_FAIL_HR))
        }
    }
}

/// Extract an i32 argument from DISPPARAMS at the given index.
///
/// Note: COM DISPPARAMS stores arguments in REVERSE order (last arg at index 0).
unsafe fn extract_i32_arg(params: *const DISPPARAMS, index: u32) -> Option<i32> {
    if params.is_null() {
        return None;
    }
    let params = &*params;
    if index >= params.cArgs {
        return None;
    }
    // Arguments are in reverse order in rgvarg
    let arg_index = (params.cArgs - 1 - index) as usize;
    let arg = &*params.rgvarg.add(arg_index);
    if arg.Anonymous.Anonymous.vt == VT_I4 {
        Some(arg.Anonymous.Anonymous.Anonymous.lVal)
    } else {
        None
    }
}
