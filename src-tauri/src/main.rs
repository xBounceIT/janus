#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod host_keys;
mod state;

use tauri::Manager;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .compact()
        .init();

    install_rustls_provider();

    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data directory");

            let state = tauri::async_runtime::block_on(state::AppState::new(app_data_dir))
                .expect("failed to initialize app state");

            app.manage(state);

            #[cfg(windows)]
            disable_windows_webview_autofill(app);
            #[cfg(windows)]
            apply_windows_titlebar_colors(app);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault_initialize,
            commands::vault_unlock,
            commands::vault_lock,
            commands::vault_status,
            commands::connection_tree_list,
            commands::folder_upsert,
            commands::connection_upsert,
            commands::node_delete,
            commands::ssh_session_open,
            commands::ssh_host_key_update_from_mismatch,
            commands::ssh_session_write,
            commands::ssh_session_resize,
            commands::ssh_session_close,
            commands::rdp_launch,
            commands::rdp_session_open,
            commands::rdp_session_close,
            commands::rdp_session_set_bounds,
            commands::rdp_session_show,
            commands::rdp_session_hide,
            commands::import_mremoteng,
            commands::export_mremoteng,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Janus");
}

fn install_rustls_provider() {
    let provider = rustls::crypto::ring::default_provider();
    if provider.install_default().is_err() {
        tracing::debug!("rustls crypto provider already installed");
    } else {
        tracing::info!("installed rustls ring crypto provider");
    }
}

#[cfg(windows)]
fn apply_windows_titlebar_colors<R: tauri::Runtime>(app: &tauri::App<R>) {
    use windows::Win32::Graphics::Dwm::{
        DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR, DwmSetWindowAttribute,
    };

    // Mirrors the frontend theme tokens `--bg-surface` and `--text` in `src/styles.css`.
    let caption_color = windows_colorref(0x1e, 0x1e, 0x2e);
    let text_color = windows_colorref(0xcd, 0xd6, 0xf4);

    let Some(main_window) = app.get_webview_window("main") else {
        tracing::warn!("main webview window not found; skipping native title bar color setup");
        return;
    };

    let hwnd = match main_window.hwnd() {
        Ok(hwnd) => hwnd,
        Err(error) => {
            tracing::warn!(?error, "failed to resolve main window handle; skipping title bar color setup");
            return;
        }
    };

    if let Err(error) = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_CAPTION_COLOR,
            &caption_color as *const u32 as *const _,
            std::mem::size_of::<u32>() as u32,
        )
    } {
        tracing::warn!(?error, "failed to set native title bar caption color");
    }

    if let Err(error) = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_TEXT_COLOR,
            &text_color as *const u32 as *const _,
            std::mem::size_of::<u32>() as u32,
        )
    } {
        tracing::warn!(?error, "failed to set native title bar text color");
    }
}

#[cfg(windows)]
const fn windows_colorref(r: u8, g: u8, b: u8) -> u32 {
    (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
}

#[cfg(windows)]
fn disable_windows_webview_autofill<R: tauri::Runtime>(app: &tauri::App<R>) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
    use windows_core::Interface;

    let Some(main_window) = app.get_webview_window("main") else {
        tracing::warn!("main webview window not found; skipping WebView2 autofill suppression");
        return;
    };

    if let Err(error) = main_window.with_webview(|webview| unsafe {
        let Ok(core_webview2) = webview.controller().CoreWebView2() else {
            tracing::warn!("WebView2 controller missing CoreWebView2 instance");
            return;
        };

        let Ok(settings) = core_webview2.Settings() else {
            tracing::warn!("WebView2 settings unavailable");
            return;
        };

        let Ok(settings4) = settings.cast::<ICoreWebView2Settings4>() else {
            tracing::warn!(
                "WebView2 Settings4 unavailable; falling back to input-level suppression"
            );
            return;
        };

        if let Err(error) = settings4.SetIsGeneralAutofillEnabled(false) {
            tracing::warn!(?error, "failed to disable WebView2 general autofill");
        }

        if let Err(error) = settings4.SetIsPasswordAutosaveEnabled(false) {
            tracing::warn!(?error, "failed to disable WebView2 password autosave");
        }
    }) {
        tracing::warn!(
            ?error,
            "failed to access platform webview for autofill suppression"
        );
    }
}
