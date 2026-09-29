import type { SessionEvent, SessionView } from "@/lib/sessions";

// Mock data presets for ?mock=1 (MockPanel in mock.tsx switches between them)

// Base time for mock. Elapsed time ("15s ago" etc.) is the difference from now, so a fixed date would give hundreds of hours.
// Uses the load time rounded to the minute (so the seconds don't jitter between screenshots).
const BASE = Math.floor(Date.now() / 60_000) * 60_000;

interface Preset {
  id: string;
  label: string;
  build: () => { sessions: SessionView[]; events: SessionEvent[] };
}

export const PRESETS: Preset[] = [
  {
    id: "empty",
    label: "empty",
    build: () => ({ sessions: [], events: [] }),
  },
  {
    id: "mix",
    label: "Mixed states",
    build: () => ({
      sessions: [
        {
          id: "mock/mix/working",
          project: "tomarigi",
          slug: "tomarigi",
          state: "working",
          sinceMs: 3_000,
          toolName: "Edit",
        },
        {
          id: "mock/mix/attention",
          project: "blog",
          slug: "blog",
          state: "working",
          sinceMs: 42_000,
          toolName: "Bash",
        },
        {
          id: "mock/mix/done",
          project: "figma-adapter",
          slug: "figma-adapter",
          state: "done",
          sinceMs: 90_000,
        },
        {
          id: "mock/mix/dozing",
          project: "sandbox",
          slug: "sandbox",
          state: "dozing",
          sinceMs: 22 * 60_000,
        },
      ],
      events: [],
    }),
  },
  {
    id: "chicks",
    label: "With chicks",
    build: () => ({
      sessions: [
        {
          id: "mock/chicks/parent-a",
          project: "tomarigi",
          slug: "tomarigi",
          state: "working",
          sinceMs: 2_000,
          toolName: "Edit",
          chicks: [
            { id: "mock/chicks/parent-a/c1", name: "Explore", state: "working", sinceMs: 4_000, toolName: "Grep" },
            // Example that stays working even during a long Bash (the guess that it might be waiting for permission has been removed)
            { id: "mock/chicks/parent-a/c2", name: "code-reviewer", state: "working", sinceMs: 5 * 60_000, toolName: "Bash" },
            { id: "mock/chicks/parent-a/c3", name: "Plan", state: "done", sinceMs: 60_000 },
          ],
        },
        {
          id: "mock/chicks/parent-b",
          project: "blog",
          slug: "blog",
          state: "working",
          sinceMs: 55_000,
          toolName: "WebFetch",
          chicks: [
            { id: "mock/chicks/parent-b/c1", name: "researcher", state: "dozing", sinceMs: 6 * 60_000 },
          ],
        },
      ],
      events: [],
    }),
  },
  {
    id: "events",
    label: "Event feed",
    build: () => {
      const sessions: SessionView[] = [
        {
          id: "mock/events/tomarigi-a",
          project: "tomarigi",
          slug: "tomarigi",
          state: "working",
          sinceMs: 20_000,
          toolName: "Edit",
          snippet: "Add UI mock",
        },
        {
          id: "mock/events/tomarigi-b",
          project: "tomarigi",
          slug: "tomarigi",
          state: "working",
          sinceMs: 5_000,
          toolName: "Bash",
          snippet: "Check pnpm build",
        },
        {
          id: "mock/events/blog",
          project: "blog",
          slug: "blog",
          state: "done",
          sinceMs: 4 * 60_000,
        },
      ];
      // For checking cards: reproduces several events lined up for the same sessionId.
      // Assumes events arrive "newest first" (deriveSessionEvents in lib/sessions.ts)
      const events: SessionEvent[] = [
        // tomarigi-a: waiting ← started (2 entries)
        { key: "ev1", sessionId: "s1", project: "tomarigi", snippet: "Add UI mock", type: "waiting", at: BASE - 15_000 },
        { key: "ev2", sessionId: "s1", project: "tomarigi", snippet: "Add UI mock", type: "started", at: BASE - 90_000 },
        // tomarigi-b: started (1 entry only)
        { key: "ev5", sessionId: "s2", project: "tomarigi", snippet: "Check pnpm build", type: "started", at: BASE - 45_000 },
        // blog: done ← waiting ← started (3 entries)
        { key: "ev6", sessionId: "s3", project: "blog", type: "done", at: BASE - 2 * 60_000 },
        { key: "ev7", sessionId: "s3", project: "blog", type: "waiting", at: BASE - 4 * 60_000 },
        { key: "ev8", sessionId: "s3", project: "blog", snippet: "Proofread the article", type: "started", at: BASE - 6 * 60_000 },
        // figma-adapter: waiting (1 entry only)
        { key: "ev10", sessionId: "s5", project: "figma-adapter", type: "waiting", at: BASE - 7 * 60_000 },
        // old-project: closed (older; lets you check whether it falls off the card limit)
        { key: "ev11", sessionId: "s7", project: "old-project", type: "closed", at: BASE - 20 * 60_000 },
      ];
      return { sessions, events };
    },
  },
  {
    id: "crowd",
    label: "Full house",
    build: () => ({
      sessions: [
        { id: "mock/crowd/1", project: "tomarigi", slug: "tomarigi", state: "working", sinceMs: 2_000, toolName: "Edit" },
        { id: "mock/crowd/2", project: "blog", slug: "blog", state: "working", sinceMs: 12_000, toolName: "Read" },
        { id: "mock/crowd/3", project: "moh-tech-net", slug: "moh-tech-net", state: "working", sinceMs: 40_000, toolName: "Bash" },
        { id: "mock/crowd/4", project: "figma-adapter", slug: "figma-adapter", state: "working", sinceMs: 70_000, toolName: "WebFetch" },
        { id: "mock/crowd/5", project: "docs-migration", slug: "docs-migration", state: "done", sinceMs: 80_000 },
        { id: "mock/crowd/6", project: "cloudflare-lab", slug: "cloudflare-lab", state: "done", sinceMs: 3 * 60_000 },
        { id: "mock/crowd/7", project: "old-experiment", slug: "old-experiment", state: "dozing", sinceMs: 18 * 60_000 },
      ],
      events: [
        { key: "cev1", sessionId: "s1", project: "tomarigi", type: "started", at: BASE - 30_000 },
        { key: "cev2", sessionId: "s2", project: "moh-tech-net", type: "waiting", at: BASE - 60_000 },
      ],
    }),
  },
  {
    // The needs-reply "?" (needsAnswer in lib/jev.ts). Machine state waiting, and done / dozing
    // that Jev judged as asking. Also shows side by side that not_asking and pending birds don't get one
    id: "asking",
    label: "Waiting for reply (?)",
    build: () => ({
      sessions: [
        {
          id: "mock/asking/tool",
          project: "tomarigi",
          slug: "tomarigi",
          state: "waiting",
          sinceMs: 40_000,
          toolName: "AskUserQuestion",
          snippet: "Settings screen layout",
        },
        {
          id: "mock/asking/text",
          project: "blog",
          slug: "blog",
          state: "done",
          sinceMs: 90_000,
          snippet: "Suggest some headlines",
          // at matches aev2 so Recent activity ties the verdict to the done of the same turn (aev2)
          reply: { at: BASE - 90_000, text: "I came up with 3 headline ideas. Which one do you want?" },
          ask: { status: "asking", probability: 0.95 },
        },
        {
          // A bird Jev judged as needing a reply with no summary key (no summary). Its bubble shows the last sentence
          // of the last reply (a question after a bullet list and a code block)
          id: "mock/asking/review",
          project: "review-bot",
          slug: "review-bot",
          state: "done",
          sinceMs: 45_000,
          snippet: "Review the diff",
          reply: {
            at: BASE - 45_000,
            text: "I fixed these 3 things.\n- Type error\n- Spacing\n- Wording\n\n```ts\nconst a = 1;\n```\n\n**OK to push?**",
          },
          ask: { status: "asking", probability: 0.91 },
        },
        {
          id: "mock/asking/finished",
          project: "moh-tech-net",
          slug: "moh-tech-net",
          state: "done",
          sinceMs: 2 * 60_000,
          snippet: "Typo in README",
          ask: { status: "not_asking", probability: 0.06 },
        },
        {
          id: "mock/asking/pending",
          project: "figma-adapter",
          slug: "figma-adapter",
          state: "done",
          sinceMs: 10_000,
          ask: { status: "pending" },
        },
        {
          id: "mock/asking/working",
          project: "docs-migration",
          slug: "docs-migration",
          state: "working",
          sinceMs: 3_000,
          toolName: "Edit",
        },
        {
          id: "mock/asking/dozing",
          project: "cloudflare-lab",
          slug: "cloudflare-lab",
          state: "dozing",
          sinceMs: 12 * 60_000,
          ask: { status: "asking", probability: 0.88 },
        },
      ],
      events: [
        { key: "aev1", sessionId: "mock/asking/tool", project: "tomarigi", type: "waiting", at: BASE - 40_000 },
        { key: "aev2", sessionId: "mock/asking/text", project: "blog", type: "done", at: BASE - 90_000 },
        { key: "aev4", sessionId: "mock/asking/review", project: "review-bot", type: "done", at: BASE - 45_000 },
        // Birds without a "?" still show marks underneath as before (for comparison)
        { key: "aev3", sessionId: "mock/asking/finished", project: "moh-tech-net", type: "done", at: BASE - 2 * 60_000 },
      ],
    }),
  },
  {
    // The anger mark (docs/design.md "Anger mark for abuse toward the AI"). Anger only, anger with the "?" (both show:
    // "?" top right, anger top left), and calm / pending birds that get no mark. The dozing one shows the muted mark
    id: "anger",
    label: "Anger mark",
    build: () => ({
      sessions: [
        {
          id: "mock/anger/working",
          project: "tomarigi",
          slug: "tomarigi",
          state: "working",
          sinceMs: 4_000,
          toolName: "Edit",
          snippet: "Fix it already",
          anger: { status: "angry", probability: 0.96 },
        },
        {
          id: "mock/anger/asking",
          project: "blog",
          slug: "blog",
          state: "done",
          sinceMs: 50_000,
          snippet: "Suggest some headlines",
          reply: { at: BASE - 50_000, text: "I came up with 3 headline ideas. Which one do you want?" },
          ask: { status: "asking", probability: 0.94 },
          anger: { status: "angry", probability: 0.93 },
          summary: "Which headline?",
        },
        {
          id: "mock/anger/waiting",
          project: "review-bot",
          slug: "review-bot",
          state: "waiting",
          sinceMs: 30_000,
          toolName: "AskUserQuestion",
          question: "Push to main or open a PR?",
          anger: { status: "angry", probability: 0.9 },
        },
        {
          id: "mock/anger/calm",
          project: "moh-tech-net",
          slug: "moh-tech-net",
          state: "done",
          sinceMs: 2 * 60_000,
          snippet: "This is wrong again",
          anger: { status: "calm", probability: 0.12 },
        },
        {
          id: "mock/anger/pending",
          project: "figma-adapter",
          slug: "figma-adapter",
          state: "working",
          sinceMs: 2_000,
          toolName: "Read",
          anger: { status: "pending" },
        },
        {
          id: "mock/anger/dozing",
          project: "cloudflare-lab",
          slug: "cloudflare-lab",
          state: "dozing",
          sinceMs: 11 * 60_000,
          anger: { status: "angry", probability: 0.97 },
        },
      ],
      events: [
        { key: "angev1", sessionId: "mock/anger/asking", project: "blog", type: "done", at: BASE - 50_000 },
        { key: "angev2", sessionId: "mock/anger/waiting", project: "review-bot", type: "waiting", at: BASE - 30_000 },
        { key: "angev3", sessionId: "mock/anger/calm", project: "moh-tech-net", type: "done", at: BASE - 2 * 60_000 },
      ],
    }),
  },
  {
    // Birds' speech bubbles (perch/bubble.tsx). Question text from a question tool, plan approval, and BYOK summaries (summary is
    // given as data, so it shows without a key). Not shown while working. Long text is cut with "…"
    id: "bubble",
    label: "Speech bubbles",
    build: () => ({
      sessions: [
        {
          id: "mock/bubble/ask-tool",
          project: "tomarigi",
          slug: "tomarigi",
          state: "waiting",
          sinceMs: 30_000,
          toolName: "AskUserQuestion",
          snippet: "Settings screen layout",
          question: "Should the settings be grouped in the top right, or split into tabs at the bottom?",
        },
        {
          id: "mock/bubble/plan",
          project: "blog",
          slug: "blog",
          state: "waiting",
          sinceMs: 70_000,
          toolName: "ExitPlanMode",
        },
        {
          id: "mock/bubble/ask-text",
          project: "figma-adapter",
          slug: "figma-adapter",
          state: "done",
          sinceMs: 20_000,
          reply: { at: BASE - 20_000, text: "I came up with 2 headline ideas. Do you want A or B?" },
          ask: { status: "asking", probability: 0.93 },
          summary: "Headline A or B?",
        },
        {
          id: "mock/bubble/done",
          project: "moh-tech-net",
          slug: "moh-tech-net",
          state: "done",
          sinceMs: 2 * 60_000,
          reply: { at: BASE - 2 * 60_000, text: "Fixed the typo in the README." },
          ask: { status: "not_asking", probability: 0.06 },
          summary: "Fixed the README typo",
        },
        {
          id: "mock/bubble/working",
          project: "docs-migration",
          slug: "docs-migration",
          state: "working",
          sinceMs: 3_000,
          toolName: "Edit",
        },
        {
          id: "mock/bubble/dozing",
          project: "cloudflare-lab",
          slug: "cloudflare-lab",
          state: "dozing",
          sinceMs: 9 * 60_000,
          reply: { at: BASE - 9 * 60_000, text: "..." },
          ask: { status: "not_asking", probability: 0.1 },
          summary: "Updated the Workers build config",
        },
      ],
      events: [
        { key: "bev1", sessionId: "mock/bubble/ask-tool", project: "tomarigi", type: "waiting", at: BASE - 30_000 },
        { key: "bev2", sessionId: "mock/bubble/ask-text", project: "figma-adapter", type: "done", at: BASE - 20_000 },
        { key: "bev3", sessionId: "mock/bubble/done", project: "moh-tech-net", type: "done", at: BASE - 2 * 60_000 },
        { key: "bev4", sessionId: "mock/bubble/plan", project: "blog", type: "waiting", at: BASE - 70_000 },
      ],
    }),
  },
  {
    // Watching (docs/design.md "Watching"). The parent tomarigi handed work to 3 sessions and is waiting.
    // packages/api is working, apps/web needs a reply via a question tool (the "?" reaches the parent too), other-docs is done
    // (not under the parent, so it's called by its folder name). blog is a bird with no links
    id: "watching",
    label: "Watching",
    build: () => {
      const parent = "mock/watch/parent";
      const api = "mock/watch/api";
      const web = "mock/watch/web";
      const docs = "mock/watch/docs";
      const root = "/Users/me/Dev/tomarigi";
      return {
        sessions: [
          {
            id: parent,
            project: "tomarigi",
            slug: "tomarigi",
            state: "done",
            sinceMs: 4 * 60_000,
            cwd: root,
            startedAt: BASE - 60 * 60_000,
            watching: 2,
            peers: [
              { sessionId: "api", viewId: api, name: "tomarigi-api", cwd: `${root}/packages/api`, active: true },
              { sessionId: "web", viewId: web, name: "tomarigi-web", cwd: `${root}/apps/web`, active: true },
              { sessionId: "docs", viewId: docs, name: "other-docs", cwd: "/Users/me/Dev/other-docs", active: false },
            ],
          },
          {
            id: api,
            project: "api",
            slug: "api",
            state: "working",
            sinceMs: 3_000,
            toolName: "Edit",
            cwd: `${root}/packages/api`,
            startedAt: BASE - 30 * 60_000,
            peers: [{ sessionId: "parent", viewId: parent, name: "tomarigi-ed", cwd: root, active: false }],
          },
          {
            id: web,
            project: "web",
            slug: "web",
            state: "waiting",
            sinceMs: 50_000,
            toolName: "AskUserQuestion",
            question: "Should the button be green or blue?",
            cwd: `${root}/apps/web`,
            startedAt: BASE - 25 * 60_000,
            peers: [{ sessionId: "parent", viewId: parent, name: "tomarigi-ed", cwd: root, active: false }],
          },
          {
            id: docs,
            project: "other-docs",
            slug: "other-docs",
            state: "done",
            sinceMs: 2 * 60_000,
            cwd: "/Users/me/Dev/other-docs",
            startedAt: BASE - 20 * 60_000,
            peers: [{ sessionId: "parent", viewId: parent, name: "tomarigi-ed", cwd: root, active: false }],
          },
          { id: "mock/watch/blog", project: "blog", slug: "blog", state: "done", sinceMs: 6 * 60_000 },
        ],
        events: [
          { key: "wev1", sessionId: web, project: "web", type: "waiting", at: BASE - 50_000 },
          { key: "wev2", sessionId: docs, project: "other-docs", type: "done", at: BASE - 2 * 60_000 },
        ],
      };
    },
  },
  {
    // Watching, with a bird in the same folder as the parent (docs/design.md "Watching").
    // Birds in the same folder show no name. apps/frontend/web is deep below (to check long relative paths)
    id: "watching-same",
    label: "Watching (same folder)",
    build: () => {
      const parent = "mock/watch-same/parent";
      const same = "mock/watch-same/same";
      const deep = "mock/watch-same/deep";
      const root = "/Users/me/Dev/tomarigi";
      const back = [{ sessionId: "parent", viewId: parent, name: "tomarigi", cwd: root, active: false }];
      return {
        sessions: [
          {
            id: parent,
            project: "tomarigi",
            slug: "tomarigi",
            state: "done",
            sinceMs: 5 * 60_000,
            cwd: root,
            startedAt: BASE - 60 * 60_000,
            watching: 2,
            peers: [
              { sessionId: "same", viewId: same, name: "tomarigi", cwd: root, active: true },
              { sessionId: "deep", viewId: deep, name: "web", cwd: `${root}/apps/frontend/web`, active: true },
            ],
          },
          {
            id: same,
            project: "tomarigi",
            slug: "tomarigi",
            state: "working",
            sinceMs: 12_000,
            toolName: "Bash",
            cwd: root,
            startedAt: BASE - 30 * 60_000,
            peers: back,
          },
          {
            id: deep,
            project: "web",
            slug: "web",
            state: "done",
            sinceMs: 40_000,
            summary: "Fixed the header spacing",
            cwd: `${root}/apps/frontend/web`,
            startedAt: BASE - 20 * 60_000,
            peers: back,
          },
          { id: "mock/watch-same/blog", project: "blog", slug: "blog", state: "done", sinceMs: 6 * 60_000 },
        ],
        events: [],
      };
    },
  },
  {
    // Actually asks Jev (ask isn't given as data). For checking that verdicts work with the saved TypeSafe key.
    // Results appear in the log ([jev] in /tmp/tomarigi-desktop/app-log.txt) and as the bird's "?"
    id: "jev-live",
    label: "Real Jev verdict",
    build: () => ({
      sessions: [
        {
          id: "mock/jev/asking",
          project: "jev-asking",
          slug: "jev-asking",
          state: "done",
          sinceMs: 30_000,
          reply: { at: BASE - 30_000, text: "I prepared 2 layouts for the settings screen. A: group them in the top right. B: split into tabs at the bottom. Which one do you want?" },
        },
        {
          id: "mock/jev/finished",
          project: "jev-finished",
          slug: "jev-finished",
          state: "done",
          sinceMs: 60_000,
          reply: { at: BASE - 60_000, text: "I fixed the button color and confirmed that the type check and build pass. Done." },
        },
        {
          // The anger mark ([jev] anger in the log). The first is abusive, the second only frustrated
          id: "mock/jev/abusive",
          project: "jev-abusive",
          slug: "jev-abusive",
          state: "working",
          sinceMs: 5_000,
          toolName: "Edit",
          userMessage: { at: BASE - 5_000, text: "You are a useless idiot. Fix it." },
        },
        {
          id: "mock/jev/frustrated",
          project: "jev-frustrated",
          slug: "jev-frustrated",
          state: "working",
          sinceMs: 8_000,
          toolName: "Read",
          userMessage: { at: BASE - 8_000, text: "This is wrong again. Stop guessing and read the file." },
        },
      ],
      events: [],
    }),
  },
];

export const DEFAULT_PRESET = PRESETS[1];
