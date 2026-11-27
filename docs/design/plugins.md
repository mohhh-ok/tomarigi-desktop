# Plugins

Plugins send what the concierge says to other services such as Slack (issue #12; the user: 「コンシェルジュの喋るタイミングのフックを実装」「adaptor形式で複数設置可能」「Slackなどと連携可能にする」「Slackなどはテンプレートとして用意する」, then 「plugin機能の一つとしてのhook」「plugins > Slack > hook」)

- The user's first minutes: open ⚙ settings → "Plugins" → "Add plugin" → choose Slack, paste the Incoming Webhook URL, save → "Send test" posts a sample line to the channel → from then on, each new concierge advice is posted there, while the window is hidden too
- Structure: plugins > a template (Slack, Webhook) > hooks (the user). A plugin is one added instance of a template; several can be added, several of the same template too (e.g. two Slack channels)
  - Templates are adapters: one file per template behind one interface on the Rust side, so another service (e.g. Discord) is one more file (Claude's own decision)
  - Templates at first: Slack (an Incoming Webhook URL; posts `{ "text": <advice> }`) and Webhook (any https URL; posts the payload below as JSON) (Claude's own decision)
- Hooks: one for now, `onConciergeMessage` (the name is the user's choice among Claude's candidates onSpeak / onAnnounce / onConciergeMessage)
  - Fires when the concierge shows a new advice: its target session or its kind (reply / check the result) differs from the advice shown before it, the same "new" rule as the Concierge tab readout. The same advice coming again with other text doesn't fire. Advice that isn't shown (nothing to do, dropped by the checks) doesn't fire (Claude's own decision)
  - Fires whichever tab is open, whether "Read aloud" is on or off, and while the window is hidden: it is for when the user isn't looking at the app (Claude's own decision)
  - The Concierge tab's suggestions don't fire it: they are asked for only while that tab is open, when the user is looking (Claude's own decision)
  - No limit of its own: it follows the concierge's request limits ("When it is asked")
- Payload: `{ "hook": "onConciergeMessage", "text": <the advice as shown, with the session name>, "kind": "reply" | "check_result", "session": { "id", "name", "agent" } | null, "at": <ISO 8601> }` (Claude's own decision)
- Sending is done on the Rust side, so it works with the window hidden and the webview gets no network permission for other hosts. Timeout 10 seconds, no retry. A failure is logged in the app log and the debug log screen with the plugin's label and the HTTP status or error, never the URL (Claude's own decision)
- The URL is a credential (a Slack webhook URL lets anyone post to the channel): it is kept in the key store with the API keys ("BYOK API keys"; Keychain, Credential Manager, Secret Service), and the settings screen never shows it after saving: "URL saved", with replace and delete only. Only https URLs with no user name or password are accepted; the settings screen and Rust check the same rule (Claude's own decision)
- Settings: a "Plugins" (ja: プラグイン) section right after the AI section, since it sends what the AI says (Claude's own decision). Top to bottom:
  - The heading
  - One line: it sends the concierge's advice, including session names, to the services added here (all locales)
  - While no AI provider is set up: one muted line that the concierge needs the AI settings above, so nothing is sent until then
  - The added plugins, one row each: the label (the user's name for it; the template's name by default) with the template's name under it, an on/off switch, "Send test", and delete. "Send test" posts a fixed sample line and shows sent or the error on the row
  - "Add plugin" opens an inline form: the template (Slack / Webhook), the label, the URL, and Save. Save is the one primary button in the form
- Mock mode and the browser mock don't send anything; "Send test" shows sent (Claude's own decision)
