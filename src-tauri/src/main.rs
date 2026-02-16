#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod state;

use tauri::Manager;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .compact()
        .init();

    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data directory");

            let state = tauri::async_runtime::block_on(state::AppState::new(app_data_dir))
                .expect("failed to initialize app state");

            app.manage(state);
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
            commands::ssh_session_write,
            commands::ssh_session_resize,
            commands::ssh_session_close,
            commands::rdp_launch,
            commands::import_mremoteng,
            commands::export_mremoteng,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Janus");
}
