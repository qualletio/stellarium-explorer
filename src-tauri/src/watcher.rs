//! Tells the webview when workspace files change outside the app (an editor, `git pull`).

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{Debouncer, new_debouncer};
use tauri::{AppHandle, Emitter};

pub const TREE_CHANGED: &str = "tree-changed";

pub struct Watcher {
    app: AppHandle,
    debouncer: Mutex<Option<Debouncer<RecommendedWatcher>>>,
}

impl Watcher {
    pub fn new(app: AppHandle) -> Self {
        Self { app, debouncer: Mutex::new(None) }
    }

    /// Replaces the watched set with `paths`.
    pub fn watch(&self, paths: Vec<PathBuf>) {
        let app = self.app.clone();
        let debouncer = new_debouncer(Duration::from_millis(300), move |result: notify_debouncer_mini::DebounceEventResult| {
            if result.is_ok_and(|events| events.iter().any(|e| !is_temp(&e.path))) {
                let _ = app.emit(TREE_CHANGED, ());
            }
        });
        let Ok(mut debouncer) = debouncer else { return };
        for path in paths {
            // A workspace folder that has gone missing shows up as broken in the tree instead.
            let _ = debouncer.watcher().watch(&path, RecursiveMode::Recursive);
        }
        *self.debouncer.lock().unwrap() = Some(debouncer);
    }
}

/// Atomic writes go through `*.tmp` files; their churn isn't a change worth reporting.
fn is_temp(path: &std::path::Path) -> bool {
    path.extension().is_some_and(|ext| ext == "tmp")
}
