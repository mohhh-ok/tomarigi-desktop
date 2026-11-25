#!/bin/sh
# Calls one of the app's MCP tools (docs/design.md "Settings by an AI agent (MCP)") with curl, for checks on the verify
# .app started with TOMARIGI_AGENT_ACCESS=<port> and a known token (README). The server is stateless and answers JSON.
#   TOKEN=<token> PORT=<port> sh tools/mcp-call.sh <tool name> '<arguments as JSON>'
# Prints the tool's answer (the JSON-RPC response)
: "${TOKEN:?TOKEN is required}" "${PORT:?PORT is required}"
name=$1
args=${2:-"{}"}
curl -sS "http://127.0.0.1:$PORT/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2025-06-18" \
  --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$name\",\"arguments\":$args}}"
echo
