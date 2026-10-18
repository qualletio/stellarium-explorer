//! Runs RequestScript requests on a Stellarium node (`POST /v1/run`).

use std::time::Instant;

use serde::Serialize;
use serde_json::{Value, json};

use crate::config::node_base;
use crate::registry::root_cause;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    /// The HTTP status, or `None` when the node couldn't be reached.
    pub status: Option<u16>,
    pub duration_ms: u64,
    /// The script's `returnValue` on success.
    pub return_value: Option<Value>,
    /// The raw response body.
    pub body: String,
    pub error: Option<String>,
}

pub async fn run(http: &reqwest::Client, node_url: &str, api_key: Option<&str>, source: &str) -> RunResult {
    let started = Instant::now();
    let mut request = http.post(format!("{}/v1/run", node_base(node_url))).json(&json!({ "source": source }));
    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(e) => {
            return RunResult {
                status: None,
                duration_ms: elapsed(started),
                return_value: None,
                body: String::new(),
                error: Some(format!("Couldn't reach the node: {}", root_cause(&e))),
            };
        }
    };
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    let duration_ms = elapsed(started);
    let parsed: Option<Value> = serde_json::from_str(&body).ok();

    if status == 200 {
        if let Some(return_value) = parsed.as_ref().and_then(|v| v.get("returnValue")) {
            return RunResult { status: Some(status), duration_ms, return_value: Some(return_value.clone()), body, error: None };
        }
        return RunResult { status: Some(status), duration_ms, return_value: None, body, error: Some("The node's response had no returnValue".into()) };
    }

    let message = parsed.as_ref().and_then(|v| v.get("error")).and_then(Value::as_str).map(String::from);
    let details = parsed.as_ref().and_then(|v| v.get("details")).and_then(Value::as_str).map(String::from);
    let error = match (status, message, details) {
        (401, _, _) if api_key.is_none() => "The node requires an API key. Add one in the network settings.".to_string(),
        (401, _, _) => "The node rejected the API key.".to_string(),
        (_, Some(message), Some(details)) => format!("{message}: {details}"),
        (_, Some(message), None) => message,
        (_, None, _) => format!("The node returned HTTP {status}"),
    };
    RunResult { status: Some(status), duration_ms, return_value: None, body, error: Some(error) }
}

fn elapsed(started: Instant) -> u64 {
    started.elapsed().as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn returns_the_return_value() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/run"))
            .and(header("authorization", "Bearer secret"))
            .and(body_json(json!({ "source": "request R { return 1 }" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "returnValue": { "ok": true } })))
            .mount(&server)
            .await;

        let result = run(&reqwest::Client::new(), &format!("{}/v1/", server.uri()), Some("secret"), "request R { return 1 }").await;
        assert_eq!(result.status, Some(200));
        assert_eq!(result.return_value, Some(json!({ "ok": true })));
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
        let parse = run(&client, &server.uri(), Some("bad"), "request R {").await;
        assert_eq!(parse.error.as_deref(), Some("Invalid script: Expected '}' at 3:1"));
        let unauthorized = run(&client, &server.uri(), None, "request R {}").await;
        assert_eq!(unauthorized.status, Some(401));
        assert!(unauthorized.error.unwrap().contains("requires an API key"));

        let unreachable = run(&client, "http://127.0.0.1:1", None, "request R {}").await;
        assert_eq!(unreachable.status, None);
        assert!(unreachable.error.unwrap().starts_with("Couldn't reach the node"));
    }
}
