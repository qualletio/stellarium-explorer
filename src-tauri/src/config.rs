//! Resolving a node's effective network settings from its scopes.
//!
//! Each setting resolves on its own, nearest scope first (request, then collection, then
//! workspace), so a request can override just the node and still inherit the registry.
//! The node's credentials travel with the node URL: its API key or API client comes from the
//! same scope, so credentials set for one node are never sent to a node configured elsewhere.

use serde::Serialize;
use uuid::Uuid;

use crate::model::NodeKind;
use crate::storage::Scope;

/// The mainnet registry API, used when no scope sets a registry.
pub const MAINNET_REGISTRY_URL: &str = "https://stellarium-resource-registry-production.up.railway.app/v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeRef {
    pub id: Uuid,
    pub kind: NodeKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedNetwork {
    pub registry_url: String,
    /// Where the registry came from; `None` is the built-in mainnet default.
    pub registry_from: Option<ScopeRef>,
    pub node_url: Option<String>,
    pub node_from: Option<ScopeRef>,
    /// The scope whose keychain entry holds the node's secret, if it has one: its API key, or its
    /// API client's secret.
    pub node_key_scope: Option<Uuid>,
    /// The API client the node's runs use, when its scope sets one.
    pub node_client: Option<NodeClient>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeClient {
    pub operator_url: String,
    pub client_id: String,
}

/// Resolves settings from `scopes`, nearest first.
pub fn resolve(scopes: &[Scope]) -> ResolvedNetwork {
    let registry = scopes.iter().find_map(|s| s.network.registry_url.clone().map(|url| (url, s)));
    let node = scopes.iter().find_map(|s| s.network.node_url.clone().map(|url| (url, s)));
    ResolvedNetwork {
        registry_url: registry.as_ref().map_or_else(|| MAINNET_REGISTRY_URL.to_string(), |(url, _)| url.clone()),
        registry_from: registry.map(|(_, s)| ScopeRef { id: s.id, kind: s.kind }),
        node_key_scope: node.as_ref().and_then(|(_, s)| s.network.node_key.then_some(s.id)),
        node_client: node.as_ref().and_then(|(_, s)| {
            Some(NodeClient { operator_url: s.network.operator_url.clone()?, client_id: s.network.client_id.clone()? })
        }),
        node_from: node.as_ref().map(|(_, s)| ScopeRef { id: s.id, kind: s.kind }),
        node_url: node.map(|(url, _)| url),
    }
}

/// The registry API base with a single trailing `/v1`, accepting input with or without it.
pub fn registry_base(url: &str) -> String {
    api_base(url)
}

/// The operator API base with a single trailing `/v1`, accepting input with or without it.
pub fn operator_base(url: &str) -> String {
    api_base(url)
}

fn api_base(url: &str) -> String {
    let url = url.trim().trim_end_matches('/');
    if url.ends_with("/v1") { url.to_string() } else { format!("{url}/v1") }
}

/// A node's origin without a trailing `/v1`, accepting input with or without it.
pub fn node_base(url: &str) -> String {
    let url = url.trim().trim_end_matches('/');
    url.strip_suffix("/v1").unwrap_or(url).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::NetworkConfig;

    fn scope(kind: NodeKind, registry: Option<&str>, node: Option<&str>, key: bool) -> Scope {
        Scope { id: Uuid::new_v4(), kind, network: NetworkConfig { registry_url: registry.map(Into::into), node_url: node.map(Into::into), node_key: key, ..Default::default() } }
    }

    #[test]
    fn falls_back_to_mainnet() {
        let resolved = resolve(&[scope(NodeKind::Request, None, None, false), scope(NodeKind::Workspace, None, None, false)]);
        assert_eq!(resolved.registry_url, MAINNET_REGISTRY_URL);
        assert_eq!(resolved.registry_from, None);
        assert_eq!(resolved.node_url, None);
        assert_eq!(resolved.node_key_scope, None);
    }

    #[test]
    fn nearest_scope_wins_per_field() {
        let req = scope(NodeKind::Request, None, Some("http://req-node"), false);
        let col = scope(NodeKind::Collection, Some("http://col-registry/v1"), None, false);
        let ws = scope(NodeKind::Workspace, Some("http://ws-registry/v1"), Some("http://ws-node"), true);
        let resolved = resolve(&[req.clone(), col.clone(), ws.clone()]);
        assert_eq!(resolved.registry_url, "http://col-registry/v1");
        assert_eq!(resolved.registry_from, Some(ScopeRef { id: col.id, kind: NodeKind::Collection }));
        assert_eq!(resolved.node_url.as_deref(), Some("http://req-node"));
        assert_eq!(resolved.node_from.map(|s| s.id), Some(req.id));
        // The workspace's key belongs to the workspace's node, not the request's.
        assert_eq!(resolved.node_key_scope, None);

        let resolved = resolve(&[scope(NodeKind::Request, None, None, false), col, ws.clone()]);
        assert_eq!(resolved.node_url.as_deref(), Some("http://ws-node"));
        assert_eq!(resolved.node_key_scope, Some(ws.id));
    }

    #[test]
    fn an_api_client_travels_with_its_node() {
        let client = |node: &str| NetworkConfig {
            node_url: Some(node.into()),
            node_key: true,
            operator_url: Some("http://operator/v1".into()),
            client_id: Some("cli_1".into()),
            ..Default::default()
        };
        let ws = Scope { id: Uuid::new_v4(), kind: NodeKind::Workspace, network: client("http://ws-node") };
        let resolved = resolve(&[scope(NodeKind::Request, None, None, false), ws.clone()]);
        assert_eq!(resolved.node_client, Some(NodeClient { operator_url: "http://operator/v1".into(), client_id: "cli_1".into() }));
        assert_eq!(resolved.node_key_scope, Some(ws.id));

        // A request that sets its own node doesn't send the workspace's client to it.
        let resolved = resolve(&[scope(NodeKind::Request, None, Some("http://req-node"), false), ws]);
        assert_eq!(resolved.node_client, None);
    }

    #[test]
    fn normalizes_bases() {
        assert_eq!(registry_base("http://localhost:4000"), "http://localhost:4000/v1");
        assert_eq!(registry_base("http://localhost:4000/v1/"), "http://localhost:4000/v1");
        assert_eq!(node_base("http://localhost:3100/v1"), "http://localhost:3100");
        assert_eq!(node_base(" http://localhost:3100/ "), "http://localhost:3100");
    }
}
