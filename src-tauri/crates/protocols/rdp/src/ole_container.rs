/// Minimal OLE container for hosting the MsTscAx ActiveX control.
///
/// Implements IOleClientSite, IOleInPlaceSite, and IOleInPlaceFrame — the minimum
/// interfaces required for in-place activation of an ActiveX control.
use std::sync::atomic::{AtomicIsize, Ordering};

use windows::core::{implement, Error, HRESULT, IUnknownImpl, OutRef, Ref, BOOL};
use windows::Win32::Foundation::{HWND, RECT, SIZE, S_OK};
use windows::Win32::System::Ole::{
    IOleClientSite, IOleClientSite_Impl, IOleInPlaceActiveObject, IOleInPlaceFrame,
    IOleInPlaceFrame_Impl, IOleInPlaceSite, IOleInPlaceSite_Impl, IOleInPlaceUIWindow,
    IOleInPlaceUIWindow_Impl, IOleWindow_Impl, OLEGETMONIKER, OLEINPLACEFRAMEINFO,
    OLEMENUGROUPWIDTHS, OLEWHICHMK,
};
use windows::Win32::UI::WindowsAndMessaging::GetClientRect;

// We store the HWND as an AtomicIsize so our container is Send+Sync
// (the actual COM calls only ever happen on the STA thread)
#[derive(Debug)]
#[implement(IOleClientSite, IOleInPlaceSite, IOleInPlaceFrame)]
pub struct OleContainer {
    hwnd: AtomicIsize,
}

impl OleContainer {
    pub fn new(hwnd: HWND) -> Self {
        Self {
            hwnd: AtomicIsize::new(hwnd.0 as isize),
        }
    }

    fn hwnd(&self) -> HWND {
        HWND(self.hwnd.load(Ordering::Relaxed) as *mut _)
    }
}

// ---- IOleClientSite ----

impl IOleClientSite_Impl for OleContainer_Impl {
    fn SaveObject(&self) -> windows::core::Result<()> {
        Ok(())
    }

    fn GetMoniker(
        &self,
        _dwassign: &OLEGETMONIKER,
        _dwwhichmoniker: &OLEWHICHMK,
    ) -> windows::core::Result<windows::Win32::System::Com::IMoniker> {
        Err(Error::new(HRESULT(0x80004001u32 as i32), "")) // E_NOTIMPL
    }

    fn GetContainer(
        &self,
    ) -> windows::core::Result<windows::Win32::System::Ole::IOleContainer> {
        Err(Error::new(HRESULT(0x80004002u32 as i32), "")) // E_NOINTERFACE
    }

    fn ShowObject(&self) -> windows::core::Result<()> {
        Ok(())
    }

    fn OnShowWindow(&self, _fshow: BOOL) -> windows::core::Result<()> {
        Ok(())
    }

    fn RequestNewObjectLayout(&self) -> windows::core::Result<()> {
        Err(Error::new(HRESULT(0x80004001u32 as i32), "")) // E_NOTIMPL
    }
}

// ---- IOleWindow (base of IOleInPlaceSite) ----

impl IOleWindow_Impl for OleContainer_Impl {
    fn GetWindow(&self) -> windows::core::Result<HWND> {
        Ok(self.hwnd())
    }

    fn ContextSensitiveHelp(&self, _fentermode: BOOL) -> windows::core::Result<()> {
        Err(Error::new(HRESULT(0x80004001u32 as i32), ""))
    }
}

// ---- IOleInPlaceSite ----

impl IOleInPlaceSite_Impl for OleContainer_Impl {
    fn CanInPlaceActivate(&self) -> windows::core::Result<()> {
        Ok(()) // S_OK = yes
    }

    fn OnInPlaceActivate(&self) -> windows::core::Result<()> {
        Ok(())
    }

    fn OnUIActivate(&self) -> windows::core::Result<()> {
        Ok(())
    }

    fn GetWindowContext(
        &self,
        ppframe: OutRef<'_, IOleInPlaceFrame>,
        ppdoc: OutRef<'_, IOleInPlaceUIWindow>,
        lprcposrect: *mut RECT,
        lprccliprect: *mut RECT,
        lpframeinfo: *mut OLEINPLACEFRAMEINFO,
    ) -> windows::core::Result<()> {
        unsafe {
            // Return ourselves as the frame
            if !ppframe.is_null() {
                let this: IOleInPlaceFrame = self.to_interface();
                ppframe.write(Some(this))?;
            }

            // No separate document window
            if !ppdoc.is_null() {
                ppdoc.write(None)?;
            }

            // Position and clip rectangles = full client area
            let hwnd = self.hwnd();
            let mut rc = RECT::default();
            let _ = GetClientRect(hwnd, &mut rc);

            if !lprcposrect.is_null() {
                *lprcposrect = rc;
            }
            if !lprccliprect.is_null() {
                *lprccliprect = rc;
            }

            if !lpframeinfo.is_null() {
                let info = &mut *lpframeinfo;
                info.fMDIApp = BOOL(0);
                info.hwndFrame = hwnd;
                info.haccel = windows::Win32::UI::WindowsAndMessaging::HACCEL(
                    core::ptr::null_mut(),
                );
                info.cAccelEntries = 0;
            }
        }
        Ok(())
    }

    fn Scroll(&self, _scrollextant: &SIZE) -> windows::core::Result<()> {
        Err(Error::new(HRESULT(0x80004001u32 as i32), ""))
    }

    fn OnUIDeactivate(&self, _fundoable: BOOL) -> windows::core::Result<()> {
        Ok(())
    }

    fn OnInPlaceDeactivate(&self) -> windows::core::Result<()> {
        Ok(())
    }

    fn DiscardUndoState(&self) -> windows::core::Result<()> {
        Err(Error::new(HRESULT(0x80004001u32 as i32), ""))
    }

    fn DeactivateAndUndo(&self) -> windows::core::Result<()> {
        Err(Error::new(HRESULT(0x80004001u32 as i32), ""))
    }

    fn OnPosRectChange(&self, _lprcposrect: *const RECT) -> windows::core::Result<()> {
        Ok(())
    }
}

// ---- IOleInPlaceUIWindow (base of IOleInPlaceFrame) ----

impl IOleInPlaceUIWindow_Impl for OleContainer_Impl {
    fn GetBorder(&self) -> windows::core::Result<RECT> {
        Err(Error::new(
            HRESULT(0x800401A1u32 as i32),
            "",
        )) // INPLACE_E_NOTOOLSPACE
    }

    fn RequestBorderSpace(
        &self,
        _pborderwidths: *const RECT,
    ) -> windows::core::Result<()> {
        Err(Error::new(
            HRESULT(0x800401A1u32 as i32),
            "",
        ))
    }

    fn SetBorderSpace(&self, _pborderwidths: *const RECT) -> windows::core::Result<()> {
        Ok(())
    }

    fn SetActiveObject(
        &self,
        _pactiveobject: Ref<'_, IOleInPlaceActiveObject>,
        _pszobjname: &windows::core::PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }
}

// ---- IOleInPlaceFrame ----

impl IOleInPlaceFrame_Impl for OleContainer_Impl {
    fn InsertMenus(
        &self,
        _hmenuShared: windows::Win32::UI::WindowsAndMessaging::HMENU,
        _lpMenuWidths: *mut OLEMENUGROUPWIDTHS,
    ) -> windows::core::Result<()> {
        Ok(())
    }

    fn SetMenu(
        &self,
        _hmenuShared: windows::Win32::UI::WindowsAndMessaging::HMENU,
        _holemenu: isize,
        _hwndActiveObject: HWND,
    ) -> windows::core::Result<()> {
        Ok(())
    }

    fn RemoveMenus(
        &self,
        _hmenuShared: windows::Win32::UI::WindowsAndMessaging::HMENU,
    ) -> windows::core::Result<()> {
        Ok(())
    }

    fn SetStatusText(&self, _pszstatustext: &windows::core::PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }

    fn EnableModeless(&self, _fenable: BOOL) -> windows::core::Result<()> {
        Ok(())
    }

    fn TranslateAccelerator(
        &self,
        _lpmsg: *const windows::Win32::UI::WindowsAndMessaging::MSG,
        _wid: u16,
    ) -> windows::core::Result<()> {
        Err(Error::new(S_OK, "")) // S_FALSE = not handled (use S_OK code but return err to indicate not processed)
    }
}
