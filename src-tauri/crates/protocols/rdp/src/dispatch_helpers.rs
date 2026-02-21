/// Helpers for interacting with the RDP ActiveX control via IDispatch.
///
/// Since IMsTscAx/IMsRdpClient interfaces are not in the `windows` crate,
/// we use IDispatch::GetIDsOfNames + Invoke for property access and method calls.
use windows::core::{BSTR, HRESULT, PCWSTR};
use windows::Win32::System::Com::{
    IDispatch, DISPATCH_METHOD, DISPATCH_PROPERTYPUT, DISPPARAMS,
};
use windows::Win32::System::Ole::DISPID_PROPERTYPUT;
use windows::Win32::System::Variant::VARIANT;

/// Get the DISPID for a named property/method.
pub unsafe fn get_dispid(dispatch: &IDispatch, name: &str) -> windows::core::Result<i32> {
    let wide_name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let names = [PCWSTR(wide_name.as_ptr())];
    let mut dispid = 0i32;
    dispatch.GetIDsOfNames(
        &windows::core::GUID::zeroed(),
        names.as_ptr(),
        1,
        0, // LOCALE_SYSTEM_DEFAULT
        &mut dispid,
    )?;
    Ok(dispid)
}

/// Set a BSTR (string) property via IDispatch.
pub unsafe fn put_bstr_property(
    dispatch: &IDispatch,
    name: &str,
    value: &str,
) -> windows::core::Result<()> {
    let dispid = get_dispid(dispatch, name)?;
    let bstr_value = BSTR::from(value);
    let mut arg = VARIANT::default();
    {
        let inner = &mut *arg.Anonymous.Anonymous;
        inner.vt = windows::Win32::System::Variant::VT_BSTR;
        inner.Anonymous.bstrVal = core::mem::ManuallyDrop::new(bstr_value);
    }

    let mut named_arg = DISPID_PROPERTYPUT;
    let params = DISPPARAMS {
        rgvarg: &mut arg,
        rgdispidNamedArgs: &mut named_arg,
        cArgs: 1,
        cNamedArgs: 1,
    };

    dispatch.Invoke(
        dispid,
        &windows::core::GUID::zeroed(),
        0,
        DISPATCH_PROPERTYPUT,
        &params,
        None,
        None,
        None,
    )?;
    Ok(())
}

/// Set an i32 property via IDispatch.
pub unsafe fn put_i32_property(
    dispatch: &IDispatch,
    name: &str,
    value: i32,
) -> windows::core::Result<()> {
    let dispid = get_dispid(dispatch, name)?;
    let mut arg = VARIANT::default();
    {
        let inner = &mut *arg.Anonymous.Anonymous;
        inner.vt = windows::Win32::System::Variant::VT_I4;
        inner.Anonymous.lVal = value;
    }

    let mut named_arg = DISPID_PROPERTYPUT;
    let params = DISPPARAMS {
        rgvarg: &mut arg,
        rgdispidNamedArgs: &mut named_arg,
        cArgs: 1,
        cNamedArgs: 1,
    };

    dispatch.Invoke(
        dispid,
        &windows::core::GUID::zeroed(),
        0,
        DISPATCH_PROPERTYPUT,
        &params,
        None,
        None,
        None,
    )?;
    Ok(())
}

/// Set a bool property via IDispatch.
pub unsafe fn put_bool_property(
    dispatch: &IDispatch,
    name: &str,
    value: bool,
) -> windows::core::Result<()> {
    let dispid = get_dispid(dispatch, name)?;
    let mut arg = VARIANT::default();
    {
        let inner = &mut *arg.Anonymous.Anonymous;
        inner.vt = windows::Win32::System::Variant::VT_BOOL;
        inner.Anonymous.boolVal = if value {
            windows::Win32::Foundation::VARIANT_TRUE
        } else {
            windows::Win32::Foundation::VARIANT_FALSE
        };
    }

    let mut named_arg = DISPID_PROPERTYPUT;
    let params = DISPPARAMS {
        rgvarg: &mut arg,
        rgdispidNamedArgs: &mut named_arg,
        cArgs: 1,
        cNamedArgs: 1,
    };

    dispatch.Invoke(
        dispid,
        &windows::core::GUID::zeroed(),
        0,
        DISPATCH_PROPERTYPUT,
        &params,
        None,
        None,
        None,
    )?;
    Ok(())
}

/// Get an IDispatch property that returns another IDispatch (e.g., AdvancedSettings).
pub unsafe fn get_dispatch_property(
    dispatch: &IDispatch,
    name: &str,
) -> windows::core::Result<IDispatch> {
    let dispid = get_dispid(dispatch, name)?;
    let params = DISPPARAMS::default();
    let mut result = VARIANT::default();

    dispatch.Invoke(
        dispid,
        &windows::core::GUID::zeroed(),
        0,
        windows::Win32::System::Com::DISPATCH_PROPERTYGET,
        &params,
        Some(&mut result),
        None,
        None,
    )?;

    // Extract IDispatch from the VARIANT
    let inner = &*result.Anonymous.Anonymous;
    if inner.vt == windows::Win32::System::Variant::VT_DISPATCH {
        let disp = (&*inner.Anonymous.pdispVal).clone();
        disp.ok_or_else(|| {
            windows::core::Error::new(HRESULT(-1), "dispatch property returned null IDispatch")
        })
    } else {
        Err(windows::core::Error::new(
            HRESULT(-1),
            "expected IDispatch property value",
        ))
    }
}

/// Call a method with no arguments via IDispatch.
pub unsafe fn invoke_method(dispatch: &IDispatch, name: &str) -> windows::core::Result<()> {
    let dispid = get_dispid(dispatch, name)?;
    let params = DISPPARAMS::default();

    dispatch.Invoke(
        dispid,
        &windows::core::GUID::zeroed(),
        0,
        DISPATCH_METHOD,
        &params,
        None,
        None,
        None,
    )?;
    Ok(())
}
