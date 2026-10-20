//! A client for the Stellarium resource registry API.
//!
//! The wire types mirror `@registry/types` in the stellarium-resource-registry repo.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::config::registry_base;
use crate::error::{AppError, AppResult};
use crate::storage::slug;

/// How long a catalog or resource detail is served from memory before refetching.
const TTL: Duration = Duration::from_secs(10 * 60);
/// The registry's `MAX_PAGE_SIZE`.
const PAGE_SIZE: u32 = 100;
/// Stops paging a misbehaving registry.
const MAX_CATALOG_PAGES: u32 = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_offset: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceRange {
    pub min_micro_usdc: u64,
    pub max_micro_usdc: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSummary {
    pub fqn: String,
    pub path: String,
    pub name: String,
    pub base_url: String,
    pub description: Option<String>,
    pub function_count: u32,
    #[serde(default)]
    pub matched_functions: Vec<String>,
    pub price: Option<PriceRange>,
    pub paid_function_count: u32,
    pub restricted_function_count: u32,
    pub last_seen_at: String,
    pub removed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionParameter {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentManifest {
    pub cost_micro_usdc: u64,
    pub recipient_address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceFunction {
    pub name: String,
    pub return_type: String,
    pub description: Option<String>,
    pub parameters: Vec<FunctionParameter>,
    pub payment_manifest: Option<PaymentManifest>,
    pub restricted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeInfo {
    pub base_url: String,
    pub name: Option<String>,
    pub public_key: Option<String>,
    pub is_source: bool,
    pub accepts_grant_requests: Option<bool>,
    pub grant_endpoint: Option<String>,
    pub grant_probed_at: Option<String>,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceDetail {
    pub fqn: String,
    pub path: String,
    pub name: String,
    pub base_url: String,
    pub website: Option<String>,
    pub description: Option<String>,
    pub functions: Vec<ResourceFunction>,
    pub host: Option<NodeInfo>,
    pub first_seen_at: String,
    pub last_seen_at: String,
    pub removed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRun {
    pub id: u64,
    pub source_url: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub resources_seen: u64,
    pub resources_added: u64,
    pub resources_removed: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub resources: u64,
    pub functions: u64,
    pub paid_functions: u64,
    pub restricted_functions: u64,
    pub nodes: u64,
    pub source_url: String,
    pub last_sync: Option<SyncRun>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub q: Option<String>,
    /// `all`, `path`, `name` or `function`.
    #[serde(rename = "in", skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paid: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restricted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// Every live resource a registry lists, for autocomplete.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub registry_url: String,
    pub items: Vec<ResourceSummary>,
    /// Unix milliseconds.
    pub fetched_at: u64,
    /// Set when the registry couldn't be reached and this is an older copy.
    #[serde(default)]
    pub stale: bool,
}

struct Cached<T> {
    value: T,
    at: Instant,
}

impl<T: Clone> Cached<T> {
    fn fresh(&self) -> Option<T> {
        (self.at.elapsed() < TTL).then(|| self.value.clone())
    }
}

pub struct Registry {
    http: reqwest::Client,
    cache_dir: Option<PathBuf>,
    catalogs: Mutex<HashMap<String, Cached<Catalog>>>,
    details: Mutex<HashMap<(String, String), Cached<ResourceDetail>>>,
}

impl Registry {
    /// Catalogs are also saved under `cache_dir`, so autocomplete works offline.
    pub fn new(http: reqwest::Client, cache_dir: Option<PathBuf>) -> Self {
        Self { http, cache_dir, catalogs: Mutex::default(), details: Mutex::default() }
    }

    pub async fn search(&self, registry_url: &str, query: &SearchQuery) -> AppResult<Page<ResourceSummary>> {
        let url = format!("{}/resources", registry_base(registry_url));
        self.get(self.http.get(url).query(query)).await
    }

    pub async fn stats(&self, registry_url: &str) -> AppResult<Stats> {
        self.get(self.http.get(format!("{}/stats", registry_base(registry_url)))).await
    }

    pub async fn resource(&self, registry_url: &str, fqn: &str) -> AppResult<ResourceDetail> {
        let base = registry_base(registry_url);
        let key = (base.clone(), fqn.to_string());
        if let Some(detail) = self.details.lock().unwrap().get(&key).and_then(Cached::fresh) {
            return Ok(detail);
        }
        let mut url = reqwest::Url::parse(&base).map_err(|e| AppError::Invalid(format!("invalid registry URL: {e}")))?;
        url.path_segments_mut().map_err(|_| AppError::Invalid("invalid registry URL".into()))?.push("resources").push(fqn);
        let detail: ResourceDetail = self.get(self.http.get(url)).await?;
        self.details.lock().unwrap().insert(key, Cached { value: detail.clone(), at: Instant::now() });
        Ok(detail)
    }

    /// Every live resource on the registry. Served from memory for `TTL` unless `refresh`, which
    /// also drops the registry's cached details; when the registry is unreachable, falls back to
    /// the last saved copy, marked `stale`.
    pub async fn catalog(&self, registry_url: &str, refresh: bool) -> AppResult<Catalog> {
        let base = registry_base(registry_url);
        if !refresh && let Some(catalog) = self.catalogs.lock().unwrap().get(&base).and_then(Cached::fresh) {
            return Ok(catalog);
        }
        match self.fetch_catalog(&base).await {
            Ok(catalog) => {
                self.catalogs.lock().unwrap().insert(base.clone(), Cached { value: catalog.clone(), at: Instant::now() });
                self.save_catalog(&catalog);
                if refresh {
                    self.details.lock().unwrap().retain(|(registry, _), _| *registry != base);
                }
                Ok(catalog)
            }
            Err(error) => {
                let previous = self.catalogs.lock().unwrap().get(&base).map(|c| c.value.clone()).or_else(|| self.load_catalog(&base));
                previous.map(|c| Catalog { stale: true, ..c }).ok_or(error)
            }
        }
    }

    async fn fetch_catalog(&self, base: &str) -> AppResult<Catalog> {
        let mut items = Vec::new();
        let mut offset = 0;
        for _ in 0..MAX_CATALOG_PAGES {
            let query = SearchQuery { offset: Some(offset), limit: Some(PAGE_SIZE), ..Default::default() };
            let page: Page<ResourceSummary> = self.get(self.http.get(format!("{base}/resources")).query(&query)).await?;
            items.extend(page.items.into_iter().filter(|r| r.removed_at.is_none()));
            match page.next_offset {
                Some(next) if next > offset => offset = next,
                _ => break,
            }
        }
        Ok(Catalog { registry_url: base.to_string(), items, fetched_at: now_millis(), stale: false })
    }

    fn catalog_path(&self, base: &str) -> Option<PathBuf> {
        self.cache_dir.as_ref().map(|dir| dir.join(format!("catalog-{}.json", slug(base))))
    }

    fn save_catalog(&self, catalog: &Catalog) {
        // The cache is best-effort; failing to write it only costs offline autocomplete.
        if let Some(path) = self.catalog_path(&catalog.registry_url) {
            let _ = std::fs::create_dir_all(path.parent().expect("cache files have a parent"));
            let _ = std::fs::write(path, serde_json::to_vec(catalog).expect("catalog serializes"));
        }
    }

    fn load_catalog(&self, base: &str) -> Option<Catalog> {
        let bytes = std::fs::read(self.catalog_path(base)?).ok()?;
        serde_json::from_slice::<Catalog>(&bytes).ok().filter(|c| c.registry_url == base)
    }

    async fn get<T: DeserializeOwned>(&self, request: reqwest::RequestBuilder) -> AppResult<T> {
        let response = request.send().await.map_err(|e| AppError::Http(format!("registry unreachable: {}", root_cause(&e))))?;
        let status = response.status();
        if !status.is_success() {
            let message = response
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|body| body.get("error").and_then(|e| e.as_str()).map(String::from))
                .unwrap_or_else(|| status.canonical_reason().unwrap_or("error").to_string());
            return Err(AppError::Http(format!("registry returned {}: {message}", status.as_u16())));
        }
        response.json().await.map_err(|e| AppError::Http(format!("unexpected registry response: {e}")))
    }
}

fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// reqwest's top-level message ("error sending request") hides why; the innermost source says it.
pub fn root_cause(error: &(dyn std::error::Error + 'static)) -> String {
    let mut current = error;
    while let Some(source) = current.source() {
        current = source;
    }
    current.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn summary(fqn: &str, removed: bool) -> serde_json::Value {
        let (path, name) = fqn.rsplit_once('.').unwrap();
        json!({
            "fqn": fqn, "path": path, "name": name, "baseUrl": "http://node", "description": null,
            "functionCount": 1, "matchedFunctions": [], "price": null, "paidFunctionCount": 0,
            "restrictedFunctionCount": 0, "lastSeenAt": "2026-10-18T00:00:00Z",
            "removedAt": if removed { json!("2026-10-18T00:00:00Z") } else { json!(null) },
        })
    }

    fn weather() -> serde_json::Value {
        json!({
            "fqn": "com.example.Weather", "path": "com.example", "name": "Weather", "baseUrl": "http://node",
            "website": null, "description": "Forecasts",
            "functions": [{
                "name": "temperature", "returnType": "decimal", "description": null,
                "parameters": [{ "name": "city", "type": "string", "description": "City name" }],
                "paymentManifest": { "costMicroUsdc": 5000, "recipientAddress": "abc" }, "restricted": false,
            }],
            "host": null, "firstSeenAt": "2026-10-18T00:00:00Z", "lastSeenAt": "2026-10-18T00:00:00Z", "removedAt": null,
        })
    }

    #[tokio::test]
    async fn pages_through_the_catalog() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/resources"))
            .and(query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "items": [summary("a.One", false), summary("a.Gone", true)], "nextOffset": 2 })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/resources"))
            .and(query_param("offset", "2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "items": [summary("b.Two", false)], "nextOffset": null })))
            .mount(&server)
            .await;

        let cache = tempfile::tempdir().unwrap();
        let registry = Registry::new(reqwest::Client::new(), Some(cache.path().to_path_buf()));
        let catalog = registry.catalog(&server.uri(), false).await.unwrap();
        assert_eq!(catalog.items.iter().map(|r| r.fqn.as_str()).collect::<Vec<_>>(), ["a.One", "b.Two"]);
        assert!(!catalog.stale);

        // When the registry fails, a new client falls back to the saved copy.
        server.reset().await;
        Mock::given(method("GET")).respond_with(ResponseTemplate::new(503)).mount(&server).await;
        let offline = Registry::new(reqwest::Client::new(), Some(cache.path().to_path_buf()));
        let stale = offline.catalog(&catalog.registry_url, false).await.unwrap();
        assert!(stale.stale);
        assert_eq!(stale.items.len(), 2);
    }

    #[tokio::test]
    async fn fetches_and_caches_resource_detail() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/resources/com.example.Weather"))
            .respond_with(ResponseTemplate::new(200).set_body_json(weather()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/resources/missing.Thing"))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({ "error": "Resource not found" })))
            .mount(&server)
            .await;

        let registry = Registry::new(reqwest::Client::new(), None);
        let base = format!("{}/v1/", server.uri());
        let detail = registry.resource(&base, "com.example.Weather").await.unwrap();
        assert_eq!(detail.functions[0].parameters[0].ty, "string");
        assert_eq!(detail.functions[0].payment_manifest.as_ref().unwrap().cost_micro_usdc, 5000);
        registry.resource(&base, "com.example.Weather").await.unwrap();

        let error = registry.resource(&base, "missing.Thing").await.unwrap_err();
        assert_eq!(error.to_string(), "registry returned 404: Resource not found");
    }

    #[tokio::test]
    async fn refreshing_the_catalog_drops_cached_details() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/resources"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "items": [summary("com.example.Weather", false)], "nextOffset": null })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/resources/com.example.Weather"))
            .respond_with(ResponseTemplate::new(200).set_body_json(weather()))
            .expect(2)
            .mount(&server)
            .await;

        let registry = Registry::new(reqwest::Client::new(), None);
        let base = format!("{}/v1/", server.uri());
        registry.resource(&base, "com.example.Weather").await.unwrap();
        registry.catalog(&base, false).await.unwrap();
        registry.resource(&base, "com.example.Weather").await.unwrap();
        registry.catalog(&base, true).await.unwrap();
        registry.resource(&base, "com.example.Weather").await.unwrap();
    }
}
