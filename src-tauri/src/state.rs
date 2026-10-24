use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::config::{self, ResolvedNetwork};
use crate::error::AppResult;
use crate::model::{NetworkConfig, NodeKind};
use crate::registry::Registry;
use crate::runner::{self, Auth, ClientCredentials, RunResult, TokenCache};
use crate::secrets::SecretStore;
use crate::storage::Storage;

pub struct AppState {
    pub storage: Storage,
    pub secrets: Box<dyn SecretStore>,
    pub registry: Registry,
    pub http: reqwest::Client,
    runs: Mutex<HashMap<String, oneshot::Sender<()>>>,
    tokens: TokenCache,
}

/// What the network settings dialog shows for one scope.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSettings {
    /// What this scope sets itself.
    pub own: NetworkConfig,
    /// What it would get from its parents if it set nothing.
    pub inherited: ResolvedNetwork,
}

/// How `set_network` treats the node's secret: its API key, or its API client's secret.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(tag = "action", content = "value", rename_all = "camelCase")]
pub enum KeyUpdate {
    Keep,
    Set(String),
    Clear,
}

impl AppState {
    pub fn new(storage: Storage, secrets: Box<dyn SecretStore>, registry: Registry, http: reqwest::Client) -> Self {
        Self { storage, secrets, registry, http, runs: Mutex::default(), tokens: TokenCache::default() }
    }

    pub fn resolve_network(&self, id: Uuid) -> AppResult<ResolvedNetwork> {
        Ok(config::resolve(&self.storage.scopes(id)?))
    }

    pub fn network_settings(&self, id: Uuid) -> AppResult<NetworkSettings> {
        let scopes = self.storage.scopes(id)?;
        let own = scopes.first().filter(|s| s.id == id).map(|s| s.network.clone()).unwrap_or_default();
        let parents = if scopes.first().is_some_and(|s| s.id == id) { &scopes[1..] } else { &scopes[..] };
        Ok(NetworkSettings { own, inherited: config::resolve(parents) })
    }

    pub fn set_network(&self, id: Uuid, network: NetworkConfig, key: KeyUpdate) -> AppResult<()> {
        let own = self.storage.scopes(id)?.into_iter().next().filter(|s| s.id == id).map(|s| s.network);
        let had_key = own.as_ref().is_some_and(|n| n.node_key);
        let mut network = network.normalized();
        let has_node = network.node_url.is_some();
        // A saved API key isn't a client secret, and one client's secret isn't another's.
        let same_credential = own.as_ref().is_some_and(|n| n.client_id == network.client_id);
        network.node_key = match &key {
            KeyUpdate::Set(secret) if has_node && !secret.trim().is_empty() => {
                self.secrets.set(id, secret.trim())?;
                true
            }
            KeyUpdate::Keep => had_key && has_node && same_credential,
            _ => false,
        };
        if had_key && !network.node_key {
            self.secrets.delete(id)?;
        }
        self.storage.set_network(id, network)
    }

    pub fn delete_node(&self, id: Uuid) -> AppResult<()> {
        for scope in self.storage.delete(id)? {
            // A leftover keychain entry is harmless; don't fail the delete over it.
            let _ = self.secrets.delete(scope);
        }
        Ok(())
    }

    /// Runs `source` on the node resolved for request `id`. A run with the same `run_id`
    /// can be cancelled with [`AppState::cancel_run`].
    pub async fn run_request(&self, id: Uuid, source: &str, run_id: String) -> AppResult<RunResult> {
        if self.storage.kind(id)? != NodeKind::Request {
            return Err(crate::error::AppError::Invalid("only requests can run".into()));
        }
        let network = self.resolve_network(id)?;
        let Some(node_url) = network.node_url else {
            return Ok(RunResult::failed(0, "No node is configured. Set a node URL in the workspace, collection or request network settings."));
        };
        let secret = match network.node_key_scope {
            Some(scope) => self.secrets.get(scope)?,
            None => None,
        };
        let auth = match (network.node_client, secret) {
            (Some(client), Some(secret)) => Some(Auth::Client(ClientCredentials { operator_url: client.operator_url, client_id: client.client_id, secret })),
            (Some(_), None) => return Ok(RunResult::failed(0, "The API client's secret isn't saved. Add it in the network settings.")),
            (None, Some(key)) => Some(Auth::ApiKey(key)),
            (None, None) => None,
        };

        let (cancel_tx, cancel_rx) = oneshot::channel();
        self.runs.lock().unwrap().insert(run_id.clone(), cancel_tx);
        let result = tokio::select! {
            result = runner::run(&self.http, &self.tokens, &node_url, auth.as_ref(), source) => result,
            _ = cancel_rx => RunResult::failed(0, "Cancelled"),
        };
        self.runs.lock().unwrap().remove(&run_id);
        Ok(result)
    }

    pub fn cancel_run(&self, run_id: &str) {
        if let Some(cancel) = self.runs.lock().unwrap().remove(run_id) {
            let _ = cancel.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryStore;

    fn state(dir: &std::path::Path) -> AppState {
        let storage = Storage::new(dir.join("settings.json"), dir.join("ws")).unwrap();
        AppState::new(storage, Box::new(MemoryStore::default()), Registry::new(reqwest::Client::new(), None), reqwest::Client::new())
    }

    #[test]
    fn keeps_keys_in_the_secret_store() {
        let tmp = tempfile::tempdir().unwrap();
        let s = state(tmp.path());
        let ws = s.storage.create_workspace("ws", None, None).unwrap();
        let col = s.storage.create_collection(ws, "col", None).unwrap();
        let req = s.storage.create_request(col, "req").unwrap();
        let node = |url: &str| NetworkConfig { node_url: Some(url.into()), ..Default::default() };

        s.set_network(ws, node("http://ws-node"), KeyUpdate::Set("secret".into())).unwrap();
        assert_eq!(s.secrets.get(ws).unwrap().as_deref(), Some("secret"));
        assert!(!std::fs::read_to_string(tmp.path().join("ws/ws/workspace.toml")).unwrap().contains("secret"));

        let resolved = s.resolve_network(req).unwrap();
        assert_eq!(resolved.node_key_scope, Some(ws));
        let settings = s.network_settings(col).unwrap();
        assert_eq!(settings.own, NetworkConfig::default());
        assert_eq!(settings.inherited.node_url.as_deref(), Some("http://ws-node"));

        // Keeping the key through an edit, then removing the node, drops the key.
        s.set_network(ws, node("http://ws-node-2"), KeyUpdate::Keep).unwrap();
        assert_eq!(s.resolve_network(req).unwrap().node_key_scope, Some(ws));
        s.set_network(ws, NetworkConfig::default(), KeyUpdate::Keep).unwrap();
        assert_eq!(s.secrets.get(ws).unwrap(), None);
    }

    #[test]
    fn switching_between_an_api_key_and_a_client_needs_a_new_secret() {
        let tmp = tempfile::tempdir().unwrap();
        let s = state(tmp.path());
        let ws = s.storage.create_workspace("ws", None, None).unwrap();
        let node = NetworkConfig { node_url: Some("http://node".into()), ..Default::default() };
        let client = |id: &str| NetworkConfig { operator_url: Some("http://operator/v1".into()), client_id: Some(id.into()), ..node.clone() };

        s.set_network(ws, node.clone(), KeyUpdate::Set("api-key".into())).unwrap();
        s.set_network(ws, client("cli_1"), KeyUpdate::Keep).unwrap();
        assert_eq!(s.secrets.get(ws).unwrap(), None, "the API key isn't kept as the client's secret");

        s.set_network(ws, client("cli_1"), KeyUpdate::Set("cs_1".into())).unwrap();
        s.set_network(ws, client("cli_1"), KeyUpdate::Keep).unwrap();
        assert_eq!(s.secrets.get(ws).unwrap().as_deref(), Some("cs_1"));
        assert_eq!(s.resolve_network(ws).unwrap().node_client.map(|c| c.client_id).as_deref(), Some("cli_1"));

        s.set_network(ws, client("cli_2"), KeyUpdate::Keep).unwrap();
        assert_eq!(s.secrets.get(ws).unwrap(), None, "another client needs its own secret");
    }

    #[tokio::test]
    async fn explains_a_missing_client_secret() {
        let tmp = tempfile::tempdir().unwrap();
        let s = state(tmp.path());
        let ws = s.storage.create_workspace("ws", None, None).unwrap();
        let col = s.storage.create_collection(ws, "col", None).unwrap();
        let req = s.storage.create_request(col, "req").unwrap();
        let client = NetworkConfig { node_url: Some("http://node".into()), operator_url: Some("http://operator".into()), client_id: Some("cli_1".into()), ..Default::default() };
        s.set_network(ws, client, KeyUpdate::Keep).unwrap();

        let result = s.run_request(req, "request R {}", "run-1".into()).await.unwrap();
        assert!(result.error.unwrap().starts_with("The API client's secret isn't saved"));
    }

    #[tokio::test]
    async fn explains_a_missing_node() {
        let tmp = tempfile::tempdir().unwrap();
        let s = state(tmp.path());
        let ws = s.storage.create_workspace("ws", None, None).unwrap();
        let col = s.storage.create_collection(ws, "col", None).unwrap();
        let req = s.storage.create_request(col, "req").unwrap();
        let result = s.run_request(req, "request R {}", "run-1".into()).await.unwrap();
        assert!(result.error.unwrap().starts_with("No node is configured"));
        assert!(s.run_request(col, "", "run-2".into()).await.is_err());
    }

    /// Against a real registry and node. Run with
    /// `E2E_REGISTRY=http://localhost:4000/v1 E2E_NODE=http://localhost:3200 E2E_KEY=... E2E_SOURCE='request R {...}' cargo test live -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_registry_and_node() {
        let env = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("set {name}"));
        let tmp = tempfile::tempdir().unwrap();
        let s = state(tmp.path());
        let ws = s.storage.create_workspace("ws", None, None).unwrap();
        let col = s.storage.create_collection(ws, "col", None).unwrap();
        let req = s.storage.create_request(col, "req").unwrap();
        s.set_network(ws, NetworkConfig { registry_url: Some(env("E2E_REGISTRY")), ..Default::default() }, KeyUpdate::Keep).unwrap();
        s.set_network(col, NetworkConfig { node_url: Some(env("E2E_NODE")), ..Default::default() }, KeyUpdate::Set(env("E2E_KEY"))).unwrap();

        let network = s.resolve_network(req).unwrap();
        let catalog = s.registry.catalog(&network.registry_url, false).await.unwrap();
        assert!(!catalog.items.is_empty());
        let detail = s.registry.resource(&network.registry_url, &catalog.items[0].fqn).await.unwrap();
        assert!(!detail.functions.is_empty());

        let result = s.run_request(req, &env("E2E_SOURCE"), "live".into()).await.unwrap();
        assert_eq!(result.error, None, "{}", result.body);
        println!("catalog: {} resources; returnValue: {}", catalog.items.len(), result.return_value.unwrap());
    }

    /// Against a real operator and node, as an API client. Run with
    /// `E2E_OPERATOR=http://localhost:3001/v1 E2E_NODE=http://localhost:3002 E2E_CLIENT_ID=... E2E_CLIENT_SECRET=... E2E_SOURCE='request R {...}' cargo test live_api_client -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_api_client() {
        let env = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("set {name}"));
        let tmp = tempfile::tempdir().unwrap();
        let s = state(tmp.path());
        let ws = s.storage.create_workspace("ws", None, None).unwrap();
        let col = s.storage.create_collection(ws, "col", None).unwrap();
        let req = s.storage.create_request(col, "req").unwrap();
        let network = NetworkConfig { node_url: Some(env("E2E_NODE")), operator_url: Some(env("E2E_OPERATOR")), client_id: Some(env("E2E_CLIENT_ID")), ..Default::default() };
        s.set_network(col, network, KeyUpdate::Set(env("E2E_CLIENT_SECRET"))).unwrap();

        for attempt in 1..=2 {
            let result = s.run_request(req, &env("E2E_SOURCE"), format!("live-{attempt}")).await.unwrap();
            assert_eq!(result.error, None, "{}", result.body);
            println!("run {attempt}: returnValue {} using {:?} tokens in {} ms", result.return_value.unwrap(), result.usage_tokens, result.duration_ms);
        }
    }
}
