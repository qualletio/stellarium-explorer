//! The Tauri command surface. Each command is a thin wrapper over `AppState`.

use std::path::PathBuf;

use tauri::State;
use uuid::Uuid;

use crate::config::ResolvedNetwork;
use crate::error::AppResult;
use crate::model::{NetworkConfig, RequestDoc, Tree};
use crate::registry::{Catalog, Page, ResourceDetail, ResourceSummary, SearchQuery, Stats};
use crate::runner::RunResult;
use crate::state::{AppState, KeyUpdate, NetworkSettings};
use crate::watcher::Watcher;

#[tauri::command]
pub fn get_tree(state: State<AppState>) -> Tree {
    state.storage.tree()
}

#[tauri::command]
pub fn create_workspace(
    state: State<AppState>,
    watcher: State<Watcher>,
    name: String,
    description: Option<String>,
    location: Option<PathBuf>,
) -> AppResult<Uuid> {
    let id = state.storage.create_workspace(&name, description, location)?;
    watcher.watch(state.storage.workspace_paths());
    Ok(id)
}

#[tauri::command]
pub fn open_workspace(state: State<AppState>, watcher: State<Watcher>, path: PathBuf) -> AppResult<Uuid> {
    let id = state.storage.open_workspace(path)?;
    watcher.watch(state.storage.workspace_paths());
    Ok(id)
}

#[tauri::command]
pub fn close_workspace(state: State<AppState>, watcher: State<Watcher>, id: Uuid) -> AppResult<()> {
    state.storage.close_workspace(id)?;
    watcher.watch(state.storage.workspace_paths());
    Ok(())
}

#[tauri::command]
pub fn forget_workspace(state: State<AppState>, watcher: State<Watcher>, path: PathBuf) -> AppResult<()> {
    state.storage.forget_workspace_path(&path)?;
    watcher.watch(state.storage.workspace_paths());
    Ok(())
}

#[tauri::command]
pub fn create_collection(state: State<AppState>, workspace_id: Uuid, name: String, description: Option<String>) -> AppResult<Uuid> {
    state.storage.create_collection(workspace_id, &name, description)
}

#[tauri::command]
pub fn create_folder(state: State<AppState>, parent_id: Uuid, name: String) -> AppResult<Uuid> {
    state.storage.create_folder(parent_id, &name)
}

#[tauri::command]
pub fn create_request(state: State<AppState>, parent_id: Uuid, name: String) -> AppResult<Uuid> {
    state.storage.create_request(parent_id, &name)
}

#[tauri::command]
pub fn read_request(state: State<AppState>, id: Uuid) -> AppResult<RequestDoc> {
    state.storage.read_request(id)
}

#[tauri::command]
pub fn save_request(state: State<AppState>, id: Uuid, source: String) -> AppResult<()> {
    state.storage.save_request_source(id, &source)
}

#[tauri::command]
pub fn update_details(state: State<AppState>, id: Uuid, name: String, description: Option<String>) -> AppResult<()> {
    state.storage.update_details(id, &name, description)
}

#[tauri::command]
pub fn move_node(state: State<AppState>, id: Uuid, parent_id: Uuid) -> AppResult<()> {
    state.storage.move_node(id, parent_id)
}

#[tauri::command]
pub fn delete_node(state: State<AppState>, id: Uuid) -> AppResult<()> {
    state.delete_node(id)
}

#[tauri::command]
pub fn get_network(state: State<AppState>, id: Uuid) -> AppResult<NetworkSettings> {
    state.network_settings(id)
}

#[tauri::command]
pub fn set_network(state: State<AppState>, id: Uuid, network: NetworkConfig, api_key: KeyUpdate) -> AppResult<()> {
    state.set_network(id, network, api_key)
}

#[tauri::command]
pub fn resolve_network(state: State<AppState>, id: Uuid) -> AppResult<ResolvedNetwork> {
    state.resolve_network(id)
}

#[tauri::command]
pub async fn search_resources(state: State<'_, AppState>, registry_url: String, query: SearchQuery) -> AppResult<Page<ResourceSummary>> {
    state.registry.search(&registry_url, &query).await
}

#[tauri::command]
pub async fn get_resource(state: State<'_, AppState>, registry_url: String, fqn: String) -> AppResult<ResourceDetail> {
    state.registry.resource(&registry_url, &fqn).await
}

#[tauri::command]
pub async fn registry_stats(state: State<'_, AppState>, registry_url: String) -> AppResult<Stats> {
    state.registry.stats(&registry_url).await
}

#[tauri::command]
pub async fn get_catalog(state: State<'_, AppState>, registry_url: String, refresh: bool) -> AppResult<Catalog> {
    state.registry.catalog(&registry_url, refresh).await
}

#[tauri::command]
pub async fn run_request(state: State<'_, AppState>, id: Uuid, source: String, run_id: String) -> AppResult<RunResult> {
    state.run_request(id, &source, run_id).await
}

#[tauri::command]
pub fn cancel_run(state: State<AppState>, run_id: String) {
    state.cancel_run(&run_id);
}
