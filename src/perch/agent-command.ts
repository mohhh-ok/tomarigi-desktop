// The URL and the token inside the registration command (src-tauri/src/mcp.rs `registration_command`), for an agent
// other than Claude Code that takes them into its own MCP settings
export function commandParts(command: string): { url: string; token: string } | null {
  const url = command.match(/\bhttp:\/\/\S+\/mcp\b/)?.[0];
  const token = command.match(/Authorization: Bearer ([^"\s]+)/)?.[1];
  return url && token ? { url, token } : null;
}
