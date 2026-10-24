//! Workspaces live on disk as plain files, so they can be versioned and shared:
//!
//! ```text
//! <workspace>/workspace.toml
//! <workspace>/<collection>/collection.toml
//! <workspace>/<collection>/<folder>/folder.toml        (folders nest)
//! <workspace>/<collection>/<folder>/<request>.rqs      RequestScript source
//! <workspace>/<collection>/<folder>/<request>.toml     name, description, network
//! ```
//!
//! Every manifest carries a UUID, so renames on disk don't change what the app (or the
//! keychain) knows a node by. The app's own settings only list where workspaces are.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::model::{BrokenWorkspace, NetworkConfig, NodeKind, RequestDoc, Tree, TreeNode};

const WORKSPACE_MANIFEST: &str = "workspace.toml";
const COLLECTION_MANIFEST: &str = "collection.toml";
const FOLDER_MANIFEST: &str = "folder.toml";
const REQUEST_EXTENSION: &str = "rqs";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Manifest {
    id: Uuid,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "NetworkConfig::is_empty")]
    network: NetworkConfig,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Settings {
    workspaces: Vec<PathBuf>,
}

#[derive(Debug, Clone)]
struct Entry {
    kind: NodeKind,
    /// The directory of a workspace, collection or folder. For a request, the path without
    /// an extension: its files are `<path>.rqs` and `<path>.toml`.
    path: PathBuf,
    parent: Option<Uuid>,
    network: NetworkConfig,
}

#[derive(Default)]
struct Inner {
    settings: Settings,
    index: HashMap<Uuid, Entry>,
}

pub struct Storage {
    settings_path: PathBuf,
    default_root: PathBuf,
    inner: Mutex<Inner>,
}

/// One scope in a node's ancestry, nearest first, for resolving network settings.
#[derive(Debug, Clone)]
pub struct Scope {
    pub id: Uuid,
    pub kind: NodeKind,
    pub network: NetworkConfig,
}

impl Storage {
    /// `settings_path` lists the open workspaces; new workspaces go under `default_root`
    /// unless the user picks a folder.
    pub fn new(settings_path: PathBuf, default_root: PathBuf) -> AppResult<Self> {
        let settings = match fs::read_to_string(&settings_path) {
            Ok(text) => serde_json::from_str(&text).map_err(|e| AppError::Manifest { path: settings_path.display().to_string(), message: e.to_string() })?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
            Err(e) => return Err(e.into()),
        };
        let mut inner = Inner { settings, index: HashMap::new() };
        load(&mut inner);
        Ok(Self { settings_path, default_root, inner: Mutex::new(inner) })
    }

    /// The directories of every open workspace, for the file watcher.
    pub fn workspace_paths(&self) -> Vec<PathBuf> {
        self.lock().settings.workspaces.clone()
    }

    pub fn tree(&self) -> Tree {
        let mut inner = self.lock();
        load(&mut inner)
    }

    pub fn create_workspace(&self, name: &str, description: Option<String>, location: Option<PathBuf>) -> AppResult<Uuid> {
        let name = clean_name(name)?;
        let mut inner = self.lock();
        let dir = match location {
            Some(dir) => {
                if dir.join(WORKSPACE_MANIFEST).exists() {
                    return Err(AppError::Invalid(format!("{} is already a workspace; open it instead", dir.display())));
                }
                dir
            }
            None => unique_path(&self.default_root, &slug(&name), ""),
        };
        fs::create_dir_all(&dir)?;
        let manifest = Manifest { id: Uuid::new_v4(), name, description: clean_description(description), network: NetworkConfig::default() };
        write_manifest(&dir.join(WORKSPACE_MANIFEST), &manifest)?;
        inner.settings.workspaces.push(dir);
        self.save_settings(&inner)?;
        load(&mut inner);
        Ok(manifest.id)
    }

    /// Adds an existing workspace folder (one with a `workspace.toml`) to the app.
    pub fn open_workspace(&self, dir: PathBuf) -> AppResult<Uuid> {
        let manifest = read_manifest(&dir.join(WORKSPACE_MANIFEST))?;
        let mut inner = self.lock();
        let dir = dir.canonicalize().unwrap_or(dir);
        if !inner.settings.workspaces.iter().any(|p| same_path(p, &dir)) {
            inner.settings.workspaces.push(dir);
            self.save_settings(&inner)?;
        }
        load(&mut inner);
        Ok(manifest.id)
    }

    /// Removes a workspace from the app without touching its files.
    pub fn close_workspace(&self, id: Uuid) -> AppResult<()> {
        let mut inner = self.lock();
        let entry = entry(&inner, id, &[NodeKind::Workspace])?;
        inner.settings.workspaces.retain(|p| !same_path(p, &entry.path));
        self.save_settings(&inner)?;
        load(&mut inner);
        Ok(())
    }

    /// Removes a workspace path that failed to load.
    pub fn forget_workspace_path(&self, path: &Path) -> AppResult<()> {
        let mut inner = self.lock();
        inner.settings.workspaces.retain(|p| !same_path(p, path));
        self.save_settings(&inner)
    }

    pub fn create_collection(&self, workspace_id: Uuid, name: &str, description: Option<String>) -> AppResult<Uuid> {
        let name = clean_name(name)?;
        let mut inner = self.lock();
        let parent = entry(&inner, workspace_id, &[NodeKind::Workspace])?;
        let dir = unique_path(&parent.path, &slug(&name), "");
        fs::create_dir_all(&dir)?;
        let manifest = Manifest { id: Uuid::new_v4(), name, description: clean_description(description), network: NetworkConfig::default() };
        write_manifest(&dir.join(COLLECTION_MANIFEST), &manifest)?;
        load(&mut inner);
        Ok(manifest.id)
    }

    pub fn create_folder(&self, parent_id: Uuid, name: &str) -> AppResult<Uuid> {
        let name = clean_name(name)?;
        let mut inner = self.lock();
        let parent = entry(&inner, parent_id, &[NodeKind::Collection, NodeKind::Folder])?;
        let dir = unique_path(&parent.path, &slug(&name), "");
        fs::create_dir_all(&dir)?;
        let manifest = Manifest { id: Uuid::new_v4(), name, description: None, network: NetworkConfig::default() };
        write_manifest(&dir.join(FOLDER_MANIFEST), &manifest)?;
        load(&mut inner);
        Ok(manifest.id)
    }

    pub fn create_request(&self, parent_id: Uuid, name: &str) -> AppResult<Uuid> {
        let name = clean_name(name)?;
        let mut inner = self.lock();
        let parent = entry(&inner, parent_id, &[NodeKind::Collection, NodeKind::Folder])?;
        let base = unique_path(&parent.path, &slug(&name), &format!(".{REQUEST_EXTENSION}"));
        let (source_path, manifest_path) = request_files(&base);
        let source = format!("request {} {{\n    return \"Hello, Stellarium!\"\n}}\n", script_name(&name));
        write_atomic(&source_path, source.as_bytes())?;
        let manifest = Manifest { id: Uuid::new_v4(), name, description: None, network: NetworkConfig::default() };
        write_manifest(&manifest_path, &manifest)?;
        load(&mut inner);
        Ok(manifest.id)
    }

    pub fn read_request(&self, id: Uuid) -> AppResult<RequestDoc> {
        let inner = self.lock();
        let entry = entry(&inner, id, &[NodeKind::Request])?;
        let (source_path, manifest_path) = request_files(&entry.path);
        let manifest = read_manifest(&manifest_path)?;
        let source = fs::read_to_string(source_path)?;
        Ok(RequestDoc { id, name: manifest.name, description: manifest.description, source, network: manifest.network })
    }

    pub fn save_request_source(&self, id: Uuid, source: &str) -> AppResult<()> {
        let inner = self.lock();
        let entry = entry(&inner, id, &[NodeKind::Request])?;
        write_atomic(&request_files(&entry.path).0, source.as_bytes())
    }

    /// Renames a node and updates its description. Collections, folders and requests are
    /// renamed on disk too; a workspace keeps its folder, which the user may have chosen.
    pub fn update_details(&self, id: Uuid, name: &str, description: Option<String>) -> AppResult<()> {
        let name = clean_name(name)?;
        let mut inner = self.lock();
        let entry = entry(&inner, id, &[])?;
        let manifest_path = manifest_path(&entry);
        let mut manifest = read_manifest(&manifest_path)?;
        let renamed = manifest.name != name;
        manifest.name = name;
        if entry.kind != NodeKind::Folder {
            manifest.description = clean_description(description);
        }
        write_manifest(&manifest_path, &manifest)?;

        if renamed && entry.kind != NodeKind::Workspace {
            let parent_dir = entry.path.parent().expect("nodes below a workspace have a parent directory");
            match entry.kind {
                NodeKind::Request => {
                    let base = unique_path(parent_dir, &slug(&manifest.name), &format!(".{REQUEST_EXTENSION}"));
                    let (old_source, old_manifest) = request_files(&entry.path);
                    let (new_source, new_manifest) = request_files(&base);
                    fs::rename(old_source, new_source)?;
                    fs::rename(old_manifest, new_manifest)?;
                }
                _ => {
                    let dir = unique_path(parent_dir, &slug(&manifest.name), "");
                    fs::rename(&entry.path, dir)?;
                }
            }
        }
        load(&mut inner);
        Ok(())
    }

    pub fn set_network(&self, id: Uuid, network: NetworkConfig) -> AppResult<()> {
        let mut inner = self.lock();
        let entry = entry(&inner, id, &[NodeKind::Workspace, NodeKind::Collection, NodeKind::Request])?;
        let manifest_path = manifest_path(&entry);
        let mut manifest = read_manifest(&manifest_path)?;
        manifest.network = network.normalized();
        write_manifest(&manifest_path, &manifest)?;
        load(&mut inner);
        Ok(())
    }

    /// Moves a node under a new parent. Requests go into collections or folders, folders into
    /// collections or other folders (never their own descendants), collections into workspaces.
    pub fn move_node(&self, id: Uuid, new_parent_id: Uuid) -> AppResult<()> {
        let mut inner = self.lock();
        let node = entry(&inner, id, &[NodeKind::Collection, NodeKind::Folder, NodeKind::Request])?;
        let allowed: &[NodeKind] = match node.kind {
            NodeKind::Collection => &[NodeKind::Workspace],
            _ => &[NodeKind::Collection, NodeKind::Folder],
        };
        let parent = entry(&inner, new_parent_id, allowed)?;
        if node.parent == Some(new_parent_id) {
            return Ok(());
        }
        if ancestors(&inner, new_parent_id).contains(&id) {
            return Err(AppError::Invalid("a folder can't move into itself".into()));
        }
        let name = node.path.file_name().expect("nodes have file names").to_string_lossy().to_string();
        match node.kind {
            NodeKind::Request => {
                let base = unique_path(&parent.path, &name, &format!(".{REQUEST_EXTENSION}"));
                let (old_source, old_manifest) = request_files(&node.path);
                let (new_source, new_manifest) = request_files(&base);
                fs::rename(old_source, new_source)?;
                fs::rename(old_manifest, new_manifest)?;
            }
            _ => fs::rename(&node.path, unique_path(&parent.path, &name, ""))?,
        }
        load(&mut inner);
        Ok(())
    }

    /// Deletes a collection, folder or request from disk. Returns the ids of deleted scopes
    /// that kept a node API key, so the caller can remove those keys from the keychain.
    pub fn delete(&self, id: Uuid) -> AppResult<Vec<Uuid>> {
        let mut inner = self.lock();
        let node = entry(&inner, id, &[NodeKind::Collection, NodeKind::Folder, NodeKind::Request])?;
        let keyed: Vec<Uuid> =
            inner.index.iter().filter(|(scope, e)| e.network.node_key && ancestors(&inner, **scope).contains(&id)).map(|(scope, _)| *scope).collect();
        match node.kind {
            NodeKind::Request => {
                let (source, manifest) = request_files(&node.path);
                fs::remove_file(source)?;
                fs::remove_file(manifest)?;
            }
            _ => fs::remove_dir_all(&node.path)?,
        }
        load(&mut inner);
        Ok(keyed)
    }

    /// The node and its ancestors that can carry network settings, nearest first.
    pub fn scopes(&self, id: Uuid) -> AppResult<Vec<Scope>> {
        let inner = self.lock();
        entry(&inner, id, &[])?;
        Ok(ancestors(&inner, id)
            .into_iter()
            .filter_map(|scope| {
                let e = &inner.index[&scope];
                e.kind.has_network().then(|| Scope { id: scope, kind: e.kind, network: e.network.clone() })
            })
            .collect())
    }

    pub fn kind(&self, id: Uuid) -> AppResult<NodeKind> {
        Ok(entry(&self.lock(), id, &[])?.kind)
    }

    #[cfg(test)]
    pub fn parent(&self, id: Uuid) -> AppResult<Option<Uuid>> {
        Ok(entry(&self.lock(), id, &[])?.parent)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn save_settings(&self, inner: &Inner) -> AppResult<()> {
        if let Some(dir) = self.settings_path.parent() {
            fs::create_dir_all(dir)?;
        }
        let json = serde_json::to_vec_pretty(&inner.settings).expect("settings serialize");
        write_atomic(&self.settings_path, &json)
    }
}

fn entry(inner: &Inner, id: Uuid, kinds: &[NodeKind]) -> AppResult<Entry> {
    let entry = inner.index.get(&id).cloned().ok_or_else(|| AppError::NotFound(format!("node {id}")))?;
    if !kinds.is_empty() && !kinds.contains(&entry.kind) {
        return Err(AppError::Invalid(format!("not allowed on a {:?}", entry.kind).to_lowercase()));
    }
    Ok(entry)
}

/// The node itself followed by its ancestors up to the workspace.
fn ancestors(inner: &Inner, id: Uuid) -> Vec<Uuid> {
    let mut chain = vec![id];
    let mut current = inner.index.get(&id).and_then(|e| e.parent);
    while let Some(parent) = current {
        chain.push(parent);
        current = inner.index.get(&parent).and_then(|e| e.parent);
    }
    chain
}

fn manifest_path(entry: &Entry) -> PathBuf {
    match entry.kind {
        NodeKind::Workspace => entry.path.join(WORKSPACE_MANIFEST),
        NodeKind::Collection => entry.path.join(COLLECTION_MANIFEST),
        NodeKind::Folder => entry.path.join(FOLDER_MANIFEST),
        NodeKind::Request => request_files(&entry.path).1,
    }
}

fn request_files(base: &Path) -> (PathBuf, PathBuf) {
    let with = |ext: &str| {
        let mut path = OsString::from(base.as_os_str());
        path.push(".");
        path.push(ext);
        PathBuf::from(path)
    };
    (with(REQUEST_EXTENSION), with("toml"))
}

// Loading

/// Rebuilds the index from disk and returns the tree.
fn load(inner: &mut Inner) -> Tree {
    let mut index = HashMap::new();
    let mut seen = HashSet::new();
    let mut workspaces = Vec::new();
    let mut broken = Vec::new();
    for dir in &inner.settings.workspaces {
        match load_workspace(dir, &mut index, &mut seen) {
            Ok(node) => workspaces.push(node),
            Err(e) => broken.push(BrokenWorkspace { path: dir.display().to_string(), error: e.to_string() }),
        }
    }
    inner.index = index;
    Tree { workspaces, broken }
}

fn load_workspace(dir: &Path, index: &mut HashMap<Uuid, Entry>, seen: &mut HashSet<Uuid>) -> AppResult<TreeNode> {
    let manifest = load_manifest(&dir.join(WORKSPACE_MANIFEST), seen)?;
    let id = manifest.id;
    let mut children = Vec::new();
    for sub in subdirectories(dir)? {
        if sub.join(COLLECTION_MANIFEST).is_file() {
            // One unreadable collection shouldn't hide the rest of the workspace.
            if let Ok(collection) = load_container(&sub, NodeKind::Collection, id, index, seen) {
                children.push(collection);
            }
        }
    }
    sort(&mut children);
    index.insert(id, Entry { kind: NodeKind::Workspace, path: dir.to_path_buf(), parent: None, network: manifest.network.clone() });
    Ok(node(manifest, NodeKind::Workspace, children))
}

fn load_container(dir: &Path, kind: NodeKind, parent: Uuid, index: &mut HashMap<Uuid, Entry>, seen: &mut HashSet<Uuid>) -> AppResult<TreeNode> {
    let file = if kind == NodeKind::Collection { COLLECTION_MANIFEST } else { FOLDER_MANIFEST };
    let mut manifest = load_manifest(&dir.join(file), seen)?;
    if kind == NodeKind::Folder {
        manifest.network = NetworkConfig::default();
    }
    let id = manifest.id;
    let mut children = Vec::new();
    for sub in subdirectories(dir)? {
        if sub.join(FOLDER_MANIFEST).is_file()
            && let Ok(folder) = load_container(&sub, NodeKind::Folder, id, index, seen)
        {
            children.push(folder);
        }
    }
    let mut sources: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file() && p.extension().is_some_and(|ext| ext == REQUEST_EXTENSION))
        .collect();
    sources.sort();
    for source in sources {
        let base = source.with_extension("");
        let manifest_path = request_files(&base).1;
        if !manifest_path.exists() {
            // Adopt a script added by hand (or by git) without a manifest.
            let name = base.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let adopted = Manifest { id: Uuid::new_v4(), name, description: None, network: NetworkConfig::default() };
            if write_manifest(&manifest_path, &adopted).is_err() {
                continue;
            }
        }
        if let Ok(request) = load_manifest(&manifest_path, seen) {
            index.insert(request.id, Entry { kind: NodeKind::Request, path: base, parent: Some(id), network: request.network.clone() });
            children.push(node(request, NodeKind::Request, Vec::new()));
        }
    }
    sort(&mut children);
    index.insert(id, Entry { kind, path: dir.to_path_buf(), parent: Some(parent), network: manifest.network.clone() });
    Ok(node(manifest, kind, children))
}

/// Reads a manifest, giving it a fresh id if another node already has its id (a copied folder).
fn load_manifest(path: &Path, seen: &mut HashSet<Uuid>) -> AppResult<Manifest> {
    let mut manifest = read_manifest(path)?;
    if !seen.insert(manifest.id) {
        manifest.id = Uuid::new_v4();
        seen.insert(manifest.id);
        write_manifest(path, &manifest)?;
    }
    Ok(manifest)
}

fn node(manifest: Manifest, kind: NodeKind, children: Vec<TreeNode>) -> TreeNode {
    TreeNode {
        id: manifest.id,
        kind,
        name: manifest.name,
        description: manifest.description,
        network: kind.has_network().then_some(manifest.network),
        children,
    }
}

/// Folders before requests, then by name.
fn sort(children: &mut [TreeNode]) {
    children.sort_by_key(|c| (c.kind == NodeKind::Request, c.name.to_lowercase()));
}

fn subdirectories(dir: &Path) -> AppResult<Vec<PathBuf>> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir() && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')))
        .collect();
    dirs.sort();
    Ok(dirs)
}

// Files

fn read_manifest(path: &Path) -> AppResult<Manifest> {
    let text = fs::read_to_string(path).map_err(|e| AppError::Manifest { path: path.display().to_string(), message: e.to_string() })?;
    toml::from_str(&text).map_err(|e| AppError::Manifest { path: path.display().to_string(), message: e.to_string() })
}

fn write_manifest(path: &Path, manifest: &Manifest) -> AppResult<()> {
    let text = toml::to_string_pretty(manifest).map_err(|e| AppError::Invalid(e.to_string()))?;
    write_atomic(path, text.as_bytes())
}

/// Writes through a temporary file, so a crash never leaves a half-written file.
fn write_atomic(path: &Path, contents: &[u8]) -> AppResult<()> {
    let mut tmp = OsString::from(path.as_os_str());
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, contents)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// `dir/stem` plus a numeric suffix when `dir/stem{suffix}` is taken.
fn unique_path(dir: &Path, stem: &str, suffix: &str) -> PathBuf {
    let taken = |candidate: &str| dir.join(format!("{candidate}{suffix}")).exists();
    let mut candidate = stem.to_string();
    let mut n = 2;
    while taken(&candidate) {
        candidate = format!("{stem}-{n}");
        n += 1;
    }
    dir.join(candidate)
}

fn same_path(a: &Path, b: &Path) -> bool {
    a == b || matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y)
}

// Names

fn clean_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Invalid("a name is required".into()));
    }
    Ok(name.to_string())
}

fn clean_description(description: Option<String>) -> Option<String> {
    description.map(|d| d.trim().to_string()).filter(|d| !d.is_empty())
}

/// A file-system-safe name: lowercase ASCII letters and digits joined by dashes.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "untitled".into() } else { out }
}

/// A RequestScript identifier for a new request's declaration: `get weather` becomes `GetWeather`.
fn script_name(name: &str) -> String {
    let ident: String = name
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut chars = w.chars();
            let first = chars.next().expect("non-empty word").to_ascii_uppercase();
            std::iter::once(first).chain(chars).collect::<String>()
        })
        .collect();
    match ident.chars().next() {
        None => "NewRequest".into(),
        Some(c) if c.is_ascii_digit() => format!("Request{ident}"),
        Some(_) => ident,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn storage(dir: &Path) -> Storage {
        Storage::new(dir.join("settings.json"), dir.join("workspaces")).unwrap()
    }

    fn find(nodes: &[TreeNode], id: Uuid) -> Option<&TreeNode> {
        nodes.iter().find_map(|n| if n.id == id { Some(n) } else { find(&n.children, id) })
    }

    #[test]
    fn creates_and_reloads_a_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let s = storage(tmp.path());
        let ws = s.create_workspace("My Workspace", Some("desc".into()), None).unwrap();
        let col = s.create_collection(ws, "Weather APIs", None).unwrap();
        let folder = s.create_folder(col, "Oslo").unwrap();
        let req = s.create_request(folder, "get temperature").unwrap();

        assert!(tmp.path().join("workspaces/my-workspace/weather-apis/oslo/get-temperature.rqs").is_file());
        let doc = s.read_request(req).unwrap();
        assert!(doc.source.starts_with("request GetTemperature {"));

        // A fresh instance reads the same tree back from disk.
        let tree = storage(tmp.path()).tree();
        let ws_node = &tree.workspaces[0];
        assert_eq!(ws_node.id, ws);
        assert_eq!(ws_node.description.as_deref(), Some("desc"));
        assert_eq!(find(&tree.workspaces, req).unwrap().name, "get temperature");
        assert!(find(&tree.workspaces, folder).unwrap().network.is_none());
    }

    #[test]
    fn renames_and_moves_on_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let s = storage(tmp.path());
        let ws = s.create_workspace("ws", None, None).unwrap();
        let col = s.create_collection(ws, "col", None).unwrap();
        let a = s.create_folder(col, "a").unwrap();
        let b = s.create_folder(col, "b").unwrap();
        let req = s.create_request(a, "req").unwrap();

        s.update_details(req, "Renamed Request", Some("  ".into())).unwrap();
        let root = tmp.path().join("workspaces/ws/col");
        assert!(root.join("a/renamed-request.rqs").is_file());
        assert!(!root.join("a/req.rqs").exists());

        s.move_node(req, b).unwrap();
        assert!(root.join("b/renamed-request.toml").is_file());
        assert_eq!(s.parent(req).unwrap(), Some(b));
        assert_eq!(s.read_request(req).unwrap().description, None);

        s.move_node(a, b).unwrap();
        assert!(root.join("b/a/folder.toml").is_file());
        assert!(matches!(s.move_node(b, a), Err(AppError::Invalid(_))));
        assert!(matches!(s.move_node(req, ws), Err(AppError::Invalid(_))));
    }

    #[test]
    fn saves_sources_and_network_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let s = storage(tmp.path());
        let ws = s.create_workspace("ws", None, None).unwrap();
        let col = s.create_collection(ws, "col", None).unwrap();
        let req = s.create_request(col, "req").unwrap();

        s.save_request_source(req, "request X {}").unwrap();
        s.set_network(col, NetworkConfig { registry_url: Some(" http://r/v1 ".into()), node_url: Some("".into()), node_key: true, ..Default::default() }).unwrap();
        s.set_network(req, NetworkConfig { node_url: Some("http://n".into()), node_key: true, ..Default::default() }).unwrap();

        let scopes = s.scopes(req).unwrap();
        assert_eq!(scopes.iter().map(|sc| sc.id).collect::<Vec<_>>(), vec![req, col, ws]);
        assert_eq!(scopes[1].network, NetworkConfig { registry_url: Some("http://r/v1".into()), node_url: None, node_key: false, ..Default::default() });
        assert!(scopes[0].network.node_key);
        assert_eq!(storage(tmp.path()).read_request(req).unwrap().source, "request X {}");
    }

    #[test]
    fn deletes_and_reports_keyed_scopes() {
        let tmp = tempfile::tempdir().unwrap();
        let s = storage(tmp.path());
        let ws = s.create_workspace("ws", None, None).unwrap();
        let col = s.create_collection(ws, "col", None).unwrap();
        let folder = s.create_folder(col, "f").unwrap();
        let req = s.create_request(folder, "req").unwrap();
        s.set_network(req, NetworkConfig { node_url: Some("http://n".into()), node_key: true, ..Default::default() }).unwrap();

        assert_eq!(s.delete(folder).unwrap(), vec![req]);
        assert!(find(&s.tree().workspaces, req).is_none());
        assert!(matches!(s.delete(ws), Err(AppError::Invalid(_))));
    }

    #[test]
    fn adopts_hand_written_scripts_and_repairs_copied_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let s = storage(tmp.path());
        let ws = s.create_workspace("ws", None, None).unwrap();
        let col = s.create_collection(ws, "col", None).unwrap();
        let dir = tmp.path().join("workspaces/ws/col");
        fs::write(dir.join("handmade.rqs"), "request H {}").unwrap();
        // Copying a collection folder duplicates its id.
        fs::create_dir(dir.parent().unwrap().join("col-copy")).unwrap();
        fs::copy(dir.join(COLLECTION_MANIFEST), dir.parent().unwrap().join("col-copy").join(COLLECTION_MANIFEST)).unwrap();

        let tree = s.tree();
        let collections = &tree.workspaces[0].children;
        assert_eq!(collections.len(), 2);
        assert_ne!(collections[0].id, collections[1].id);
        let original = find(collections, col).unwrap();
        assert_eq!(original.children[0].name, "handmade");
        assert!(dir.join("handmade.toml").is_file());
    }

    #[test]
    fn opens_and_closes_existing_workspaces() {
        let tmp = tempfile::tempdir().unwrap();
        let s = storage(tmp.path());
        let elsewhere = tmp.path().join("shared/team");
        let ws = s.create_workspace("Team", None, Some(elsewhere.clone())).unwrap();
        s.close_workspace(ws).unwrap();
        assert!(s.tree().workspaces.is_empty());
        assert!(elsewhere.join(WORKSPACE_MANIFEST).is_file(), "closing keeps the files");
        assert_eq!(s.open_workspace(elsewhere.clone()).unwrap(), ws);
        assert_eq!(s.open_workspace(elsewhere).unwrap(), ws);
        assert_eq!(s.tree().workspaces.len(), 1);
    }

    #[test]
    fn makes_slugs_and_script_names() {
        assert_eq!(slug("  Hello, World! "), "hello-world");
        assert_eq!(slug("☃"), "untitled");
        assert_eq!(script_name("get weather (oslo)"), "GetWeatherOslo");
        assert_eq!(script_name("2fa check"), "Request2faCheck");
        assert_eq!(script_name("!!"), "NewRequest");
    }
}
