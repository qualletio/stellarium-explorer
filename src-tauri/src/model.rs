use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    Workspace,
    Collection,
    Folder,
    Request,
}

impl NodeKind {
    /// Folders only organize requests; they never carry network settings.
    pub fn has_network(self) -> bool {
        !matches!(self, NodeKind::Folder)
    }
}

/// Network settings a workspace, collection or request may set. Unset fields inherit.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConfig {
    /// The registry API base, such as `http://localhost:4000/v1`. Drives browsing and autocomplete.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry_url: Option<String>,
    /// The node that runs requests (`POST {nodeUrl}/v1/run`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_url: Option<String>,
    /// Whether this scope keeps an API key for its node in the OS keychain, under the scope's id.
    /// The key itself is never written to disk.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub node_key: bool,
}

impl NetworkConfig {
    pub fn is_empty(&self) -> bool {
        self.registry_url.is_none() && self.node_url.is_none() && !self.node_key
    }

    /// Trims fields and drops empty ones, so a cleared input means "inherit".
    pub fn normalized(mut self) -> Self {
        let clean = |value: Option<String>| value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        self.registry_url = clean(self.registry_url);
        self.node_url = clean(self.node_url);
        if self.node_url.is_none() {
            // A key only makes sense next to the node it belongs to.
            self.node_key = false;
        }
        self
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub id: Uuid,
    pub kind: NodeKind,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<NetworkConfig>,
    pub children: Vec<TreeNode>,
}

/// A workspace the app lists but could not load.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokenWorkspace {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tree {
    pub workspaces: Vec<TreeNode>,
    pub broken: Vec<BrokenWorkspace>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestDoc {
    pub id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub source: String,
    pub network: NetworkConfig,
}
