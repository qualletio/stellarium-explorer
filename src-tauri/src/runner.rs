//! Runs RequestScript requests on a Stellarium node (`POST /v1/run`).
//!
//! A node accepts its own API key, or a run token: a short-lived JWT the operator issues to an API
//! client (`POST {operator}/oauth/token`). Run tokens are cached per client until shortly before
//! they expire, and refetched once when the node rejects one.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Value, json};

use crate::config::{node_base, operator_base};
use crate::registry::root_cause;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    /// The HTTP status, or `None` when the node couldn't be reached.
    pub status: Option<u16>,
    pub duration_ms: u64,
    /// The script's `returnValue` on success.
    pub return_value: Option<Value>,
    /// The script tokens the run executed, as the node reports them.
    pub usage_tokens: Option<u64>,
    /// The raw response body.
    pub body: String,
    pub error: Option<String>,
}

impl RunResult {
    /// A run that never reached the node.
    pub fn failed(duration_ms: u64, error: impl Into<String>) -> Self {
        RunResult { status: None, duration_ms, return_value: None, usage_tokens: None, body: String::new(), error: Some(error.into()) }
    }
}

/// An API client's credentials, which the operator exchanges for run tokens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientCredentials {
    /// The operator API base, with or without `/v1`.
    pub operator_url: String,
    pub client_id: String,
    pub secret: String,
}

/// How a run authenticates to its node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Auth {
    ApiKey(String),
    Client(ClientCredentials),
}

/// A cached token is refetched this long before it expires, so it doesn't expire mid-run.
const TOKEN_MARGIN: Duration = Duration::from_secs(60);

/// Run tokens by operator and client id.
#[derive(Default)]
pub struct TokenCache(Mutex<HashMap<(String, String), (String, Instant)>>);

impl TokenCache {
    fn key(client: &ClientCredentials) -> (String, String) {
        (operator_base(&client.operator_url), client.client_id.clone())
    }

    fn get(&self, client: &ClientCredentials) -> Option<String> {
        let tokens = self.0.lock().unwrap();
        tokens.get(&Self::key(client)).filter(|(_, until)| Instant::now() < *until).map(|(token, _)| token.clone())
    }

    fn put(&self, client: &ClientCredentials, token: String, expires_in: Duration) {
        let until = Instant::now() + expires_in.saturating_sub(TOKEN_MARGIN);
        self.0.lock().unwrap().insert(Self::key(client), (token, until));
    }

    fn forget(&self, client: &ClientCredentials) {
        self.0.lock().unwrap().remove(&Self::key(client));
    }
}

pub async fn run(http: &reqwest::Client, tokens: &TokenCache, node_url: &str, auth: Option<&Auth>, source: &str) -> RunResult {
    let started = Instant::now();
    match auth {
        None => post_run(http, node_url, None, Credential::None, source, started).await,
        Some(Auth::ApiKey(key)) => post_run(http, node_url, Some(key), Credential::ApiKey, source, started).await,
        Some(Auth::Client(client)) => {
            let cached = tokens.get(client);
            let token = match cached.clone() {
                Some(token) => token,
                None => match fetch_token(http, tokens, client).await {
                    Ok(token) => token,
                    Err(error) => return RunResult::failed(elapsed(started), error),
                },
            };
            let result = post_run(http, node_url, Some(&token), Credential::RunToken, source, started).await;
            // A cached token may have been revoked or signed with a rotated key; a fresh one settles it.
            if result.status != Some(401) || cached.is_none() {
                return result;
            }
            tokens.forget(client);
            match fetch_token(http, tokens, client).await {
                Ok(token) => post_run(http, node_url, Some(&token), Credential::RunToken, source, started).await,
                Err(error) => RunResult::failed(elapsed(started), error),
            }
        }
    }
}

/// Exchanges the client's credentials for a run token and caches it.
async fn fetch_token(http: &reqwest::Client, tokens: &TokenCache, client: &ClientCredentials) -> Result<String, String> {
    let response = http
        .post(format!("{}/oauth/token", operator_base(&client.operator_url)))
        .form(&[("grant_type", "client_credentials"), ("client_id", &client.client_id), ("client_secret", &client.secret)])
        .send()
        .await
        .map_err(|e| format!("Couldn't reach the operator: {}", root_cause(&e)))?;
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if status != 200 {
        let description = body.get("error_description").or_else(|| body.get("error")).and_then(Value::as_str).unwrap_or("no reason given");
        return Err(format!("The operator refused the API client: {description}"));
    }
    let Some(token) = body.get("access_token").and_then(Value::as_str) else {
        return Err("The operator's token response had no access_token".into());
    };
    let expires_in = Duration::from_secs(body.get("expires_in").and_then(Value::as_u64).unwrap_or(0));
    tokens.put(client, token.to_string(), expires_in);
    Ok(token.to_string())
}

/// What a run's bearer token is, for explaining a 401.
#[derive(Clone, Copy)]
enum Credential {
    None,
    ApiKey,
    RunToken,
}

async fn post_run(http: &reqwest::Client, node_url: &str, bearer: Option<&str>, credential: Credential, source: &str, started: Instant) -> RunResult {
    let mut request = http.post(format!("{}/v1/run", node_base(node_url))).json(&json!({ "source": source }));
    if let Some(token) = bearer {
        request = request.bearer_auth(token);
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(e) => return RunResult::failed(elapsed(started), format!("Couldn't reach the node: {}", root_cause(&e))),
    };
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    let duration_ms = elapsed(started);
    let parsed: Option<Value> = serde_json::from_str(&body).ok();
    let usage_tokens = parsed.as_ref().and_then(|v| v.pointer("/usage/tokens")).and_then(Value::as_u64);

    if status == 200 {
        if let Some(return_value) = parsed.as_ref().and_then(|v| v.get("returnValue")) {
            return RunResult { status: Some(status), duration_ms, return_value: Some(return_value.clone()), usage_tokens, body, error: None };
        }
        return RunResult { status: Some(status), duration_ms, return_value: None, usage_tokens, body, error: Some("The node's response had no returnValue".into()) };
    }

    let message = parsed.as_ref().and_then(|v| v.get("error")).and_then(Value::as_str).map(String::from);
    let details = parsed.as_ref().and_then(|v| v.get("details")).and_then(Value::as_str).map(String::from);
    let error = match (status, credential, message, details) {
        (401, Credential::None, _, _) => "The node requires an API key or an API client. Add one in the network settings.".to_string(),
        (401, Credential::ApiKey, _, _) => "The node rejected the API key.".to_string(),
        (401, Credential::RunToken, message, _) => format!("The node rejected the run token: {}", message.as_deref().unwrap_or("no reason given")),
        (_, _, Some(message), Some(details)) => format!("{message}: {details}"),
        (_, _, Some(message), None) => message,
        (_, _, None, _) => format!("The node returned HTTP {status}"),
    };
    RunResult { status: Some(status), duration_ms, return_value: None, usage_tokens, body, error: Some(error) }
}

fn elapsed(started: Instant) -> u64 {
    started.elapsed().as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, body_string_contains, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn api_key(key: &str) -> Auth {
        Auth::ApiKey(key.into())
    }

    #[tokio::test]
    async fn returns_the_return_value_and_usage() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/run"))
            .and(header("authorization", "Bearer secret"))
            .and(body_json(json!({ "source": "request R { return 1 }" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "returnValue": { "ok": true }, "usage": { "tokens": 2 } })))
            .mount(&server)
            .await;

        let result = run(&reqwest::Client::new(), &TokenCache::default(), &format!("{}/v1/", server.uri()), Some(&api_key("secret")), "request R { return 1 }").await;
        assert_eq!(result.status, Some(200));
        assert_eq!(result.return_value, Some(json!({ "ok": true })));
        assert_eq!(result.usage_tokens, Some(2));
        assert_eq!(result.error, None);
    }

    #[tokio::test]
    async fn explains_failures() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/run"))
            .and(header("authorization", "Bearer bad"))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({ "error": "Invalid script", "details": "Expected '}' at 3:1" })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/run"))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({ "error": "Authorization header is required" })))
            .mount(&server)
            .await;

        let client = reqwest::Client::new();
        let tokens = TokenCache::default();
        let parse = run(&client, &tokens, &server.uri(), Some(&api_key("bad")), "request R {").await;
        assert_eq!(parse.error.as_deref(), Some("Invalid script: Expected '}' at 3:1"));
        let unauthorized = run(&client, &tokens, &server.uri(), None, "request R {}").await;
        assert_eq!(unauthorized.status, Some(401));
        assert!(unauthorized.error.unwrap().contains("requires an API key or an API client"));

        let unreachable = run(&client, &tokens, "http://127.0.0.1:1", None, "request R {}").await;
        assert_eq!(unreachable.status, None);
        assert!(unreachable.error.unwrap().starts_with("Couldn't reach the node"));
    }

    #[tokio::test]
    async fn reports_the_tokens_a_failed_script_executed() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/run"))
            .respond_with(ResponseTemplate::new(422).set_body_json(json!({ "error": "Script failed", "details": "Division by zero", "usage": { "tokens": 4 } })))
            .mount(&server)
            .await;

        let result = run(&reqwest::Client::new(), &TokenCache::default(), &server.uri(), Some(&api_key("k")), "request R {}").await;
        assert_eq!(result.error.as_deref(), Some("Script failed: Division by zero"));
        assert_eq!(result.usage_tokens, Some(4));
    }

    fn credentials(operator: &MockServer) -> ClientCredentials {
        // Without /v1, which the runner adds.
        ClientCredentials { operator_url: operator.uri(), client_id: "cli_1".into(), secret: "cs_1".into() }
    }

    async fn mount_token(operator: &MockServer, token: &str, times: u64) {
        Mock::given(method("POST"))
            .and(path("/v1/oauth/token"))
            .and(body_string_contains("grant_type=client_credentials"))
            .and(body_string_contains("client_id=cli_1"))
            .and(body_string_contains("client_secret=cs_1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "access_token": token, "token_type": "Bearer", "expires_in": 900 })))
            .up_to_n_times(times)
            .expect(times)
            .mount(operator)
            .await;
    }

    #[tokio::test]
    async fn exchanges_client_credentials_once_and_reuses_the_token() {
        let operator = MockServer::start().await;
        let node = MockServer::start().await;
        mount_token(&operator, "jwt-1", 1).await;
        Mock::given(method("POST"))
            .and(path("/v1/run"))
            .and(header("authorization", "Bearer jwt-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "returnValue": 1, "usage": { "tokens": 2 } })))
            .expect(2)
            .mount(&node)
            .await;

        let http = reqwest::Client::new();
        let tokens = TokenCache::default();
        let auth = Auth::Client(credentials(&operator));
        for _ in 0..2 {
            let result = run(&http, &tokens, &node.uri(), Some(&auth), "request R { return 1 }").await;
            assert_eq!(result.return_value, Some(json!(1)));
        }
    }

    #[tokio::test]
    async fn refetches_a_token_the_node_rejects_once() {
        let operator = MockServer::start().await;
        let node = MockServer::start().await;
        let http = reqwest::Client::new();
        let tokens = TokenCache::default();
        let client = credentials(&operator);
        tokens.put(&client, "stale".into(), Duration::from_secs(900));
        mount_token(&operator, "fresh", 1).await;
        Mock::given(method("POST"))
            .and(path("/v1/run"))
            .and(header("authorization", "Bearer stale"))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({ "error": "Invalid run token" })))
            .mount(&node)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/run"))
            .and(header("authorization", "Bearer fresh"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "returnValue": 1 })))
            .mount(&node)
            .await;

        let result = run(&http, &tokens, &node.uri(), Some(&Auth::Client(client.clone())), "request R {}").await;
        assert_eq!(result.status, Some(200));
        assert_eq!(tokens.get(&client).as_deref(), Some("fresh"));
    }

    #[tokio::test]
    async fn explains_a_refused_client_or_token() {
        let operator = MockServer::start().await;
        let node = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/oauth/token"))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({ "error": "invalid_client", "error_description": "Invalid client credentials" })))
            .mount(&operator)
            .await;

        let http = reqwest::Client::new();
        let refused = run(&http, &TokenCache::default(), &node.uri(), Some(&Auth::Client(credentials(&operator))), "request R {}").await;
        assert_eq!(refused.status, None);
        assert_eq!(refused.error.as_deref(), Some("The operator refused the API client: Invalid client credentials"));

        // A fresh token the node still rejects isn't retried.
        let operator = MockServer::start().await;
        mount_token(&operator, "jwt", 1).await;
        Mock::given(method("POST"))
            .and(path("/v1/run"))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({ "error": "Invalid run token" })))
            .expect(1)
            .mount(&node)
            .await;
        let rejected = run(&http, &TokenCache::default(), &node.uri(), Some(&Auth::Client(credentials(&operator))), "request R {}").await;
        assert_eq!(rejected.error.as_deref(), Some("The node rejected the run token: Invalid run token"));
    }
}
