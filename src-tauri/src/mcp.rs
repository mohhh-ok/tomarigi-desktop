// ---- The MCP server AI agents use to change settings ----
// docs/design.md "Settings by an AI agent (MCP)". Streamable HTTP at http://127.0.0.1:<port>/mcp, bound to 127.0.0.1
// only, refusing a request without the token. The settings live in the WebView's IndexedDB, so this side only carries
// a tool call to the page ("mcp-call") and the page's answer back (mcp_reply); the tool list comes from the page too
// (src/lib/agent-tools.ts)

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, RoleServer, ServerHandler};
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::append_log;
use crate::keys::{mcp_token, renew_mcp_token};

/// The page's answer to one tool call
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub(crate) struct ToolReply {
    pub ok: bool,
    pub text: String,
    #[serde(default)]
    pub data: Option<Value>,
}

/// Hands a call to whoever runs the tools (the page in the app, a fake in tests). The answer comes back through
/// `Pending::complete` with the same id
type Dispatch = Arc<dyn Fn(u64, String, Value) + Send + Sync>;

#[derive(Default)]
struct Pending {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, oneshot::Sender<ToolReply>>>,
}

impl Pending {
    fn open(&self) -> (u64, oneshot::Receiver<ToolReply>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        self.waiting.lock().unwrap().insert(id, tx);
        (id, rx)
    }

    fn complete(&self, id: u64, reply: ToolReply) {
        if let Some(tx) = self.waiting.lock().unwrap().remove(&id) {
            let _ = tx.send(reply);
        }
    }

    fn drop_id(&self, id: u64) {
        self.waiting.lock().unwrap().remove(&id);
    }
}

/// How long a call waits for the page. The sample's Test waits 30 s (TEST_WAIT_MS in src/lib/voice.ts)
const CALL_TIMEOUT: Duration = Duration::from_secs(60);

const INSTRUCTIONS: &str = "Tools to read and change the settings of Tomarigi, a desktop app that shows the user's \
coding agent sessions. Read get_settings first. Every change goes through the same checks as the app's settings \
screen; a refused change says why. API keys can't be read or set here: ask the user to paste a key on the settings \
screen. If a call fails to connect, Tomarigi isn't running: ask the user to start it.";

#[derive(Clone)]
struct SettingsTools {
    tools: Arc<Mutex<Vec<Tool>>>,
    pending: Arc<Pending>,
    dispatch: Dispatch,
}

impl ServerHandler for SettingsTools {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("tomarigi", env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(self.tools.lock().unwrap().clone()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let name = request.name.to_string();
        let args = Value::Object(request.arguments.unwrap_or_default());
        let (id, rx) = self.pending.open();
        let started = std::time::Instant::now();
        (self.dispatch)(id, name.clone(), args);
        let reply = match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(reply)) => reply,
            _ => {
                self.pending.drop_id(id);
                ToolReply {
                    ok: false,
                    text: "Tomarigi didn't answer. Make sure its window has loaded (reopen it from the menu bar icon) \
                           and try again."
                        .into(),
                    data: None,
                }
            }
        };
        append_log(&format!(
            "[mcp] call {name} {} ms={}",
            if reply.ok { "ok" } else { "error" },
            started.elapsed().as_millis()
        ));
        let content = vec![ContentBlock::text(reply.text)];
        let mut result = if reply.ok { CallToolResult::success(content) } else { CallToolResult::error(content) };
        result.structured_content = reply.data;
        Ok(result.into())
    }
}

/// A running server: cancelling `stop` ends the accept loop, and the listener is dropped when `accept_loop` ends
struct Running {
    port: u16,
    stop: CancellationToken,
    accept_loop: tokio::task::JoinHandle<()>,
}

impl Running {
    /// Returns once nothing listens on the port: cancelling alone leaves the listener open until the loop's task runs
    async fn shut(mut self) {
        self.stop.cancel();
        let _ = (&mut self.accept_loop).await;
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

/// Starts and stops one server at a time. The lock is held from stopping the old server to the new one's bind, so a
/// stop that comes meanwhile waits and then stops the new one, and a start never binds while the old listener is open
#[derive(Default)]
struct Server {
    running: tokio::sync::Mutex<Option<Running>>,
}

impl Server {
    async fn start(&self, port: u16, token: TokenFn, handler: SettingsTools) -> Result<(), String> {
        let mut running = self.running.lock().await;
        if let Some(old) = running.take() {
            old.shut().await;
        }
        let stop = CancellationToken::new();
        let accept_loop = serve(port, token, handler, stop.clone()).await?;
        *running = Some(Running { port, stop, accept_loop });
        Ok(())
    }

    /// False when nothing was running
    async fn stop(&self) -> bool {
        let mut running = self.running.lock().await;
        let Some(old) = running.take() else { return false };
        old.shut().await;
        true
    }

    async fn port(&self) -> Option<u16> {
        self.running.lock().await.as_ref().map(|r| r.port)
    }
}

type TokenFn = Arc<dyn Fn() -> Option<String> + Send + Sync>;

type BoxBody = http_body_util::combinators::BoxBody<Bytes, Infallible>;

fn empty(status: StatusCode) -> Response<BoxBody> {
    let mut res = Response::new(Full::new(Bytes::new()).boxed());
    *res.status_mut() = status;
    res
}

/// Compares in time that doesn't depend on where the two differ
fn same_secret(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn authorized(req: &Request<Incoming>, token: &str) -> bool {
    let Some(value) = req.headers().get(hyper::header::AUTHORIZATION) else { return false };
    let expected = format!("Bearer {token}");
    same_secret(value.as_bytes(), expected.as_bytes())
}

/// A process this app starts (`ps`, `lsof`, a terminal's CLI) gets a copy of every open socket between its fork and
/// its exec, so the listener a stop just closed can stay open for that moment. A port taken that briefly is tried again;
/// one another program holds stays taken and answers `port-in-use`
const BIND_RETRIES: u32 = 10;
const BIND_RETRY_WAIT: Duration = Duration::from_millis(50);

async fn bind(port: u16) -> Result<tokio::net::TcpListener, String> {
    let mut tries = 0;
    loop {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => return Ok(listener),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                tries += 1;
                if tries > BIND_RETRIES {
                    return Err("port-in-use".to_string());
                }
                tokio::time::sleep(BIND_RETRY_WAIT).await;
            }
            Err(e) => return Err(format!("bind: {e}")),
        }
    }
}

/// Binds 127.0.0.1:<port> and serves until `stop` is cancelled; the returned task owns the listener. `token` is read on
/// every request, so a renewed token takes effect at once
async fn serve(
    port: u16,
    token: TokenFn,
    handler: SettingsTools,
    stop: CancellationToken,
) -> Result<tokio::task::JoinHandle<()>, String> {
    let listener = bind(port).await?;
    let mut config = StreamableHttpServerConfig::default();
    // Stateless, one JSON answer per call: nothing to lose when the app restarts
    config.legacy_session_mode = false;
    config.json_response = true;
    config.sse_keep_alive = None;
    // A request a web page sends carries an Origin, and only the app's own one would pass. Requests without one (the
    // agent's CLI) pass (rmcp checks Origin only when the header is there)
    config.allowed_origins = vec![format!("http://127.0.0.1:{port}")];
    config.cancellation_token = stop.child_token();
    let mcp = StreamableHttpService::new(move || Ok(handler.clone()), LocalSessionManager::default().into(), config);
    Ok(tokio::spawn(async move {
        loop {
            let accepted = tokio::select! {
                _ = stop.cancelled() => break,
                accepted = listener.accept() => accepted,
            };
            let Ok((stream, _)) = accepted else { continue };
            let mcp = mcp.clone();
            let token = token.clone();
            let conn_stop = stop.clone();
            tokio::spawn(async move {
                let service = hyper::service::service_fn(move |req: Request<Incoming>| {
                    let mut mcp = mcp.clone();
                    let token = token.clone();
                    async move {
                        let ok = token().is_some_and(|t| authorized(&req, &t));
                        if !ok {
                            append_log("[mcp] refused 401");
                            return Ok::<_, Infallible>(empty(StatusCode::UNAUTHORIZED));
                        }
                        if req.uri().path() != "/mcp" {
                            return Ok(empty(StatusCode::NOT_FOUND));
                        }
                        use tower_service::Service;
                        let res = mcp.call(req).await?;
                        Ok(res.map(|b| b.boxed()))
                    }
                });
                let conn = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service);
                tokio::pin!(conn);
                tokio::select! {
                    _ = conn.as_mut() => {}
                    _ = conn_stop.cancelled() => conn.as_mut().graceful_shutdown(),
                }
            });
        }
    }))
}

/// The one command the user runs to register the server with Claude Code
pub(crate) fn registration_command(port: u16, token: &str) -> String {
    format!(
        "claude mcp add --scope user --transport http tomarigi http://127.0.0.1:{port}/mcp --header \"Authorization: Bearer {token}\""
    )
}

struct State {
    server: Server,
    tools: Arc<Mutex<Vec<Tool>>>,
    pending: Arc<Pending>,
}

fn state() -> &'static State {
    static STATE: std::sync::OnceLock<State> = std::sync::OnceLock::new();
    STATE.get_or_init(|| State {
        server: Server::default(),
        tools: Arc::new(Mutex::new(Vec::new())),
        pending: Arc::new(Pending::default()),
    })
}

/// Starts (or restarts on another port) the server with the page's tool list. Returns the registration command.
/// Errors: `port-in-use`, `no-key-store` (no OS store for the token), `tools: …` (a list that isn't MCP tools)
#[tauri::command]
pub(crate) async fn mcp_start(app: AppHandle, port: u16, tools: Value) -> Result<String, String> {
    let token = mcp_token()?;
    let tools: Vec<Tool> = serde_json::from_value(tools).map_err(|e| format!("tools: {e}"))?;
    let s = state();
    *s.tools.lock().unwrap() = tools;
    let handler = SettingsTools {
        tools: s.tools.clone(),
        pending: s.pending.clone(),
        dispatch: Arc::new(move |id, name, arguments| {
            let payload = serde_json::json!({ "id": id, "name": name, "arguments": arguments });
            app.emit_to("main", "mcp-call", payload).ok();
        }),
    };
    s.server.start(port, Arc::new(|| mcp_token().ok()), handler).await?;
    append_log(&format!("[mcp] start port={port}"));
    Ok(registration_command(port, &token))
}

/// Stops the server: nothing listens on the port afterwards
#[tauri::command]
pub(crate) async fn mcp_stop() -> Result<(), String> {
    if state().server.stop().await {
        append_log("[mcp] stop");
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn mcp_reply(id: u64, reply: ToolReply) {
    state().pending.complete(id, reply);
}

/// A new token; the old registration command stops working at once. Returns the new command
#[tauri::command]
pub(crate) fn mcp_renew_token(port: u16) -> Result<String, String> {
    let token = renew_mcp_token()?;
    append_log("[mcp] token renewed");
    Ok(registration_command(port, &token))
}

/// For verification, debug builds only: TOMARIGI_AGENT_ACCESS=<port> turns the setting on with that port at launch,
/// `off` turns it off (the page saves it, like TOMARIGI_LOCAL_AI). A release build always answers None
#[tauri::command]
pub(crate) fn agent_access_import() -> Option<String> {
    #[cfg(debug_assertions)]
    return Some(std::env::var("TOMARIGI_AGENT_ACCESS").ok()?.trim().to_string());
    #[cfg(not(debug_assertions))]
    None
}

/// The port of the running server, if any
#[tauri::command]
pub(crate) async fn mcp_running_port() -> Result<Option<u16>, String> {
    Ok(state().server.port().await)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "test-token-0123456789abcdef";

    fn tools() -> Vec<Tool> {
        serde_json::from_value(serde_json::json!([{
            "name": "get_settings",
            "description": "Reads the settings",
            "inputSchema": { "type": "object", "properties": {} }
        }]))
        .unwrap()
    }

    /// Tools that answer at once with the tool's name, like the page would
    fn handler() -> SettingsTools {
        let pending = Arc::new(Pending::default());
        let answer = pending.clone();
        SettingsTools {
            tools: Arc::new(Mutex::new(tools())),
            pending,
            dispatch: Arc::new(move |id, name, _| {
                answer.complete(id, ToolReply { ok: true, text: format!("ran {name}"), data: None })
            }),
        }
    }

    fn token() -> TokenFn {
        Arc::new(|| Some(TOKEN.to_string()))
    }

    async fn start(port: u16) -> CancellationToken {
        let stop = CancellationToken::new();
        serve(port, token(), handler(), stop.clone()).await.unwrap();
        stop
    }

    async fn listening(port: u16) -> bool {
        tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok()
    }

    /// Other tests start processes, and each holds a copy of the listener between its fork and its exec (see `bind`)
    async fn stops_listening(port: u16) -> bool {
        for _ in 0..BIND_RETRIES {
            if !listening(port).await {
                return true;
            }
            tokio::time::sleep(BIND_RETRY_WAIT).await;
        }
        false
    }

    async fn post(port: u16, auth: Option<&str>, origin: Option<&str>, body: &str) -> (u16, String) {
        let client = reqwest::Client::new();
        let mut req = client
            .post(format!("http://127.0.0.1:{port}/mcp"))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", "2025-06-18")
            .body(body.to_string());
        if let Some(a) = auth {
            req = req.header("Authorization", a);
        }
        if let Some(o) = origin {
            req = req.header("Origin", o);
        }
        let res = req.send().await.unwrap();
        (res.status().as_u16(), res.text().await.unwrap())
    }

    const INIT: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}"#;
    const LIST: &str = r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#;
    const CALL: &str = r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_settings","arguments":{}}}"#;

    #[tokio::test]
    async fn a_request_without_the_token_is_refused() {
        let stop = start(48441).await;
        assert_eq!(post(48441, None, None, INIT).await.0, 401);
        assert_eq!(post(48441, Some("Bearer wrong"), None, INIT).await.0, 401);
        assert_eq!(post(48441, Some(TOKEN), None, INIT).await.0, 401);
        stop.cancel();
    }

    #[tokio::test]
    async fn the_token_lists_and_calls_the_tools() {
        let stop = start(48442).await;
        let auth = format!("Bearer {TOKEN}");
        let (status, body) = post(48442, Some(&auth), None, INIT).await;
        assert_eq!(status, 200, "{body}");
        assert!(body.contains("\"tomarigi\""), "{body}");
        let (status, body) = post(48442, Some(&auth), None, LIST).await;
        assert_eq!(status, 200, "{body}");
        assert!(body.contains("get_settings"), "{body}");
        let (status, body) = post(48442, Some(&auth), None, CALL).await;
        assert_eq!(status, 200, "{body}");
        assert!(body.contains("ran get_settings"), "{body}");
        stop.cancel();
    }

    #[tokio::test]
    async fn no_origin_passes_and_another_origin_is_refused() {
        let stop = start(48443).await;
        let auth = format!("Bearer {TOKEN}");
        assert_eq!(post(48443, Some(&auth), None, INIT).await.0, 200);
        assert_eq!(post(48443, Some(&auth), Some("http://127.0.0.1:48443"), INIT).await.0, 200);
        assert_eq!(post(48443, Some(&auth), Some("https://example.com"), INIT).await.0, 403);
        stop.cancel();
    }

    #[tokio::test]
    async fn other_paths_are_not_found() {
        let stop = start(48444).await;
        let res = reqwest::Client::new()
            .get("http://127.0.0.1:48444/other")
            .header("Authorization", format!("Bearer {TOKEN}"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status().as_u16(), 404);
        stop.cancel();
    }

    #[tokio::test]
    async fn after_stopping_nothing_listens_and_the_port_can_be_bound_again() {
        let server = Server::default();
        server.start(48445, token(), handler()).await.unwrap();
        assert!(listening(48445).await);
        assert!(server.stop().await);
        assert!(stops_listening(48445).await);
        let _held = bind(48445).await.unwrap();
    }

    // Not the default current-thread runtime: there the old accept loop ends at the first await anyway, which would hide
    // a start that binds before waiting for it
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn starting_again_on_the_same_port_right_after_a_start_binds() {
        let server = Server::default();
        for _ in 0..20 {
            server.start(48447, token(), handler()).await.unwrap();
        }
        assert_eq!(server.port().await, Some(48447));
        assert!(server.stop().await);
        assert!(stops_listening(48447).await);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stop_that_waits_for_a_start_stops_the_new_server() {
        let server = Arc::new(Server::default());
        let guard = server.running.lock().await;
        let starting = tokio::spawn({
            let server = server.clone();
            async move { server.start(48449, token(), handler()).await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let stopping = tokio::spawn({
            let server = server.clone();
            async move { server.stop().await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        drop(guard);
        starting.await.unwrap().unwrap();
        assert!(stopping.await.unwrap(), "the stop that came during the start stops the server it started");
        assert!(stops_listening(48449).await);
    }

    #[tokio::test]
    async fn a_port_in_use_says_so() {
        let _held = tokio::net::TcpListener::bind(("127.0.0.1", 48446)).await.unwrap();
        let handler = SettingsTools {
            tools: Arc::new(Mutex::new(Vec::new())),
            pending: Arc::new(Pending::default()),
            dispatch: Arc::new(|_, _, _| {}),
        };
        let r = serve(48446, Arc::new(|| None), handler, CancellationToken::new()).await;
        assert_eq!(r.unwrap_err(), "port-in-use");
    }

    #[test]
    fn the_command_registers_for_every_project_with_the_token() {
        assert_eq!(
            registration_command(4844, "abc"),
            "claude mcp add --scope user --transport http tomarigi http://127.0.0.1:4844/mcp --header \"Authorization: Bearer abc\""
        );
    }

    #[test]
    fn the_token_is_256_bits_of_hex() {
        let a = crate::keys::new_mcp_token();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, crate::keys::new_mcp_token());
    }
}
