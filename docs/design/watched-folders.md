# Watched folders

- Files are read on the Rust side. The standard location of every agent in "Agents" (`~/.claude/projects`, `~/.codex/sessions`, `~/.qwen/projects`, `~/.copilot/session-state`, `~/.gemini/tmp`, `~/.local/share/opencode`, `~/.cursor/projects`) is always watched as a default (the app supplies them on every launch; they are not written into the saved list). The list of agents and their folders is kept in one place, `AGENTS` in `src/lib/agents.ts`. Other folders can be added from the settings screen (native folder picker), and only added folders can be removed. People who use a different config directory via `CLAUDE_CONFIG_DIR` (or `QWEN_HOME`, `COPILOT_HOME`, `GEMINI_CLI_HOME`, `OPENCODE_DB`) add that folder
- The add-folder dialog has one choice per agent, top to bottom: Claude Code, Codex, Qwen Code, GitHub Copilot CLI, Gemini CLI, OpenCode, Cursor CLI. Each row is "＋ <agent>" with its standard folder and a copy button, as before. Above the choices, one line tells people who moved an agent's folder with an environment variable (`CLAUDE_CONFIG_DIR`, `COPILOT_HOME`, etc.) to pick the folder with the same name inside it (Claude's own decision, from a user-view review) A default folder row is labeled with the agent's name. Birds and rows don't show which agent a session belongs to (the same as for Codex until now); when the same project name comes from two watched folders, the folder's label is added, as before
- Defaults are listed first with a "Default" badge and no remove (×) button
- Default folders that don't exist are neither watched nor listed
- Labels can be edited for defaults too; default labels are stored separately
- Entries saved by older versions' "auto-register on first launch" that match a default path are dropped on load (no double watching)
- The path is shown under each label
- There is no read-permission concept, so a missing or unreadable folder just gets an "unreadable" badge
