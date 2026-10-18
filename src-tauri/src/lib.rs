mod commands;
mod config;
mod error;
mod model;
mod registry;
mod runner;
mod secrets;
mod state;
mod storage;
mod watcher;

use std::time::Duration;

use tauri::Manager;

use crate::registry::Registry;
use crate::secrets::Keychain;
use crate::state::AppState;
use crate::storage::Storage;
use crate::watcher::Watcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let paths = app.path();
            let storage = Storage::new(paths.app_config_dir()?.join("settings.json"), paths.app_data_dir()?.join("workspaces"))?;
            let http = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(120))
                .user_agent(concat!("stellarium-explorer/", env!("CARGO_PKG_VERSION")))
                .build()?;
            let registry = Registry::new(http.clone(), paths.app_cache_dir().ok());

            let watcher = Watcher::new(app.handle().clone());
            watcher.watch(storage.workspace_paths());
            app.manage(watcher);
            app.manage(AppState::new(storage, Box::new(Keychain), registry, http));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_tree,
            commands::create_workspace,
            commands::open_workspace,
            commands::close_workspace,
            commands::forget_workspace,
            commands::create_collection,
            commands::create_folder,
            commands::create_request,
            commands::read_request,
            commands::save_request,
            commands::update_details,
            commands::move_node,
            commands::delete_node,
            commands::get_network,
            commands::set_network,
            commands::resolve_network,
            commands::search_resources,
            commands::get_resource,
            commands::registry_stats,
            commands::get_catalog,
            commands::run_request,
            commands::cancel_run,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
