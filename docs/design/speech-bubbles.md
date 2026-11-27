# Speech bubbles

- Only when a turn ends (done), the last reply is summarized briefly with BYOK OpenAI / Anthropic or Local (`src/lib/summarize.ts`). It stays until the next turn starts (working). One turn verdict per turn (two requests; see "Turn verdicts"). Without a key, no bubble
- Garden: the bird's name is above the icon. Right below the icon is a bubble of about 15 full-width characters, with an upward tail pointing at the bird. Even when the bubble is shifted left or right, the tail stays right under the icon. The status line, count at the bird's feet, and marks follow below the bubble. The whole text is shown, wrapping onto more lines past 180px, never cut with "…". Bubbles may overlap each other and birds and are drawn on top of them; bubbles from later turns are drawn on top (see "Layout")
- Perch: the same summary on one line within the row
- Recent activity: each row gets the same summary for that turn on one line. No extra summary calls. Summaries aren't stored, so events from before a restart have none
- For birds waiting on a reply, the bubble shows what is being asked, and the status line is just "needs reply · elapsed time" (ja: 返事待ち)
  - When stopped on a question tool (AskUserQuestion etc.), the question text from the tool input is shortened and shown as is (works without a key)
  - The same for a Claude desktop app session waiting on its wrap_up's `ask` (see "The "?" for sessions waiting on you")
  - While Claude Code is still showing the options (the tool_use isn't in the transcript yet; waiting comes from `sessions/<pid>.json`), there is no question text, so only the "?" is shown and no bubble. No "waiting" event (chirp) fires in that case either
