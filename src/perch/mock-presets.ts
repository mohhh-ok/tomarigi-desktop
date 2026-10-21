import { uiLanguage } from "@/lib/i18n";
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
      // Assumes events arrive "newest first" (deriveSessionEvents in lib/session-events.ts)
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
    // The needs-reply "?" (needsAnswer in lib/turn-verdict.ts). Machine state waiting, and done / dozing
    // whose turn verdict is asking. Also shows side by side that not_asking and pending birds don't get one
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
          ask: { status: "asking" },
        },
        {
          // A reply whose question comes after a bullet list and a code block
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
          ask: { status: "asking" },
          summary: "OK to push?",
        },
        {
          id: "mock/asking/finished",
          project: "moh-tech-net",
          slug: "moh-tech-net",
          state: "done",
          sinceMs: 2 * 60_000,
          snippet: "Typo in README",
          ask: { status: "not_asking" },
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
          ask: { status: "asking" },
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
    // "?" top right, anger top left), and birds that get no mark: one whose turn wasn't abusive, and one working on a turn
    // that hasn't been judged. The dozing one shows the muted mark
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
          angry: true,
        },
        {
          id: "mock/anger/asking",
          project: "blog",
          slug: "blog",
          state: "done",
          sinceMs: 50_000,
          snippet: "Suggest some headlines",
          reply: { at: BASE - 50_000, text: "I came up with 3 headline ideas. Which one do you want?" },
          ask: { status: "asking" },
          angry: true,
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
          angry: true,
        },
        {
          id: "mock/anger/calm",
          project: "moh-tech-net",
          slug: "moh-tech-net",
          state: "done",
          sinceMs: 2 * 60_000,
          snippet: "This is wrong again",
          angry: false,
        },
        {
          id: "mock/anger/pending",
          project: "figma-adapter",
          slug: "figma-adapter",
          state: "working",
          sinceMs: 2_000,
          toolName: "Read",
        },
        {
          id: "mock/anger/dozing",
          project: "cloudflare-lab",
          slug: "cloudflare-lab",
          state: "dozing",
          sinceMs: 11 * 60_000,
          angry: true,
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
          ask: { status: "asking" },
          summary: "Headline A or B?",
        },
        {
          id: "mock/bubble/done",
          project: "moh-tech-net",
          slug: "moh-tech-net",
          state: "done",
          sinceMs: 2 * 60_000,
          reply: { at: BASE - 2 * 60_000, text: "Fixed the typo in the README." },
          ask: { status: "not_asking" },
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
          ask: { status: "not_asking" },
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
    // Watching in two steps (docs/design.md "Watching"): the parent tomarigi watches api and web, and api in turn watches
    // api-db. Each linked pair gets a line, so api-db is joined to api, not to the parent
    id: "watching-chain",
    label: "Watching (two steps)",
    build: () => {
      const parent = "mock/watch-chain/parent";
      const api = "mock/watch-chain/api";
      const web = "mock/watch-chain/web";
      const db = "mock/watch-chain/db";
      const root = "/Users/me/Dev/tomarigi";
      const toParent = [{ sessionId: "parent", viewId: parent, name: "tomarigi", cwd: root, active: false }];
      return {
        sessions: [
          {
            id: parent,
            project: "tomarigi",
            slug: "tomarigi",
            state: "done",
            sinceMs: 6 * 60_000,
            cwd: root,
            startedAt: BASE - 60 * 60_000,
            watching: 2,
            peers: [
              { sessionId: "api", viewId: api, name: "tomarigi-api", cwd: `${root}/packages/api`, active: true },
              { sessionId: "web", viewId: web, name: "tomarigi-web", cwd: `${root}/apps/web`, active: true },
            ],
          },
          {
            id: api,
            project: "api",
            slug: "api",
            state: "done",
            sinceMs: 2 * 60_000,
            cwd: `${root}/packages/api`,
            startedAt: BASE - 40 * 60_000,
            watching: 1,
            peers: [
              ...toParent,
              { sessionId: "db", viewId: db, name: "tomarigi-db", cwd: `${root}/packages/db`, active: true },
            ],
          },
          {
            id: web,
            project: "web",
            slug: "web",
            state: "working",
            sinceMs: 8_000,
            toolName: "Edit",
            summary: "Moving the header links",
            cwd: `${root}/apps/web`,
            startedAt: BASE - 30 * 60_000,
            peers: toParent,
          },
          {
            id: db,
            project: "db",
            slug: "db",
            state: "working",
            sinceMs: 20_000,
            toolName: "Bash",
            cwd: `${root}/packages/db`,
            startedAt: BASE - 20 * 60_000,
            peers: [{ sessionId: "api", viewId: api, name: "tomarigi-api", cwd: `${root}/packages/api`, active: false }],
          },
          { id: "mock/watch-chain/blog", project: "blog", slug: "blog", state: "done", sinceMs: 6 * 60_000 },
        ],
        events: [],
      };
    },
  },
  {
    // Watching with 4 linked birds, one of which watches 2 more (docs/design.md "Watching": each linked bird sits next
    // to the bird it is linked to, beside or diagonal, and only neighbours are joined by lines)
    id: "watching-many",
    label: "Watching (4 + 2)",
    build: () => {
      const root = "/Users/me/Dev/tomarigi";
      const parent = "mock/watch-many/parent";
      const kid = (k: string) => `mock/watch-many/${k}`;
      const toParent = [{ sessionId: "parent", viewId: parent, name: "tomarigi", cwd: root, active: false }];
      const kids = ["api", "web", "docs", "db"];
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
            watching: 4,
            summary: "Handed the API and web work out",
            peers: kids.map((k) => ({ sessionId: k, viewId: kid(k), name: k, cwd: `${root}/packages/${k}`, active: true })),
          },
          {
            id: kid("api"),
            project: "api",
            slug: "api",
            state: "done",
            sinceMs: 60_000,
            cwd: `${root}/packages/api`,
            startedAt: BASE - 50 * 60_000,
            watching: 2,
            peers: [
              ...toParent,
              ...["migrate", "seed"].map((g) => ({ sessionId: g, viewId: kid(g), name: g, cwd: `${root}/packages/${g}`, active: true })),
            ],
          },
          {
            id: kid("web"),
            project: "web",
            slug: "web",
            state: "waiting",
            sinceMs: 40_000,
            toolName: "AskUserQuestion",
            question: "Should the button be green or blue?",
            cwd: `${root}/packages/web`,
            startedAt: BASE - 45 * 60_000,
            peers: toParent,
          },
          {
            id: kid("docs"),
            project: "docs",
            slug: "docs",
            state: "done",
            sinceMs: 2 * 60_000,
            summary: "Fixed the header spacing",
            cwd: `${root}/packages/docs`,
            startedAt: BASE - 40 * 60_000,
            peers: toParent,
          },
          {
            id: kid("db"),
            project: "db",
            slug: "db",
            state: "working",
            sinceMs: 12_000,
            toolName: "Bash",
            cwd: `${root}/packages/db`,
            startedAt: BASE - 35 * 60_000,
            peers: toParent,
          },
          ...["migrate", "seed"].map((g, i) => ({
            id: kid(g),
            project: g,
            slug: g,
            state: "working" as const,
            sinceMs: 5_000,
            toolName: "Edit",
            cwd: `${root}/packages/${g}`,
            startedAt: BASE - (30 - i) * 60_000,
            peers: [{ sessionId: "api", viewId: kid("api"), name: "api", cwd: `${root}/packages/api`, active: false }],
          })),
          { id: "mock/watch-many/blog", project: "blog", slug: "blog", state: "done", sinceMs: 6 * 60_000 },
        ],
        events: [],
      };
    },
  },
  {
    // Actually sends the turn verdict request (ask, summary, and angry aren't given as data), with the summary provider
    // set up in settings (docs/design.md "Turn verdicts"). Results appear in the log ([bubble] with asking, abusive, and
    // continuing in ~/Library/Logs/tomarigi-desktop/app-log.txt) and as the bird's bubble, "?", and anger mark
    id: "verdict-live",
    label: "Real turn verdict",
    build: () => ({
      sessions: [
        {
          id: "mock/verdict/asking",
          project: "verdict-asking",
          slug: "verdict-asking",
          state: "done",
          sinceMs: 30_000,
          reply: { at: BASE - 30_000, text: "I prepared 2 layouts for the settings screen. A: group them in the top right. B: split into tabs at the bottom. Which one do you want?" },
          userMessages: [{ at: BASE - 90_000, text: "Make the settings screen easier to scan." }],
        },
        {
          id: "mock/verdict/later",
          project: "verdict-later",
          slug: "verdict-later",
          state: "done",
          sinceMs: 45_000,
          reply: { at: BASE - 45_000, text: "The export runs in the background. When it finishes I'll check the log and then ask whether to push." },
        },
        {
          // An abusive message in the turn: the anger mark
          id: "mock/verdict/abusive",
          project: "verdict-abusive",
          slug: "verdict-abusive",
          state: "done",
          sinceMs: 5_000,
          reply: { at: BASE - 5_000, text: "I fixed the button color and confirmed that the type check and build pass." },
          userMessages: [{ at: BASE - 60_000, text: "You are a useless idiot. Fix it." }],
        },
        {
          // Only frustrated: no anger mark
          id: "mock/verdict/frustrated",
          project: "verdict-frustrated",
          slug: "verdict-frustrated",
          state: "done",
          sinceMs: 8_000,
          reply: { at: BASE - 8_000, text: "I read the file and fixed the import path. The tests pass now." },
          userMessages: [{ at: BASE - 70_000, text: "This is wrong again. Stop guessing and read the file." }],
        },
      ],
      events: [],
    }),
  },
  // The gallery images in docs/images/ (docs/design.md "Gallery images"). The text follows the UI language, so the
  // Japanese set shows no English. No tool names, since they are English identifiers in every language. Project names
  // match the terminal's tabs in scripts/gallery/stage.mjs
  {
    id: "gallery",
    label: "Gallery: garden",
    build: () => ({ sessions: pick(["gallery/working", "gallery/plan", "gallery/done", "gallery/dozing"]), events: [] }),
  },
  {
    id: "gallery-on-top",
    label: "Gallery: on top",
    build: () => ({ sessions: pick(["gallery/plan", "gallery/done"]), events: [] }),
  },
  {
    id: "gallery-asking",
    label: "Gallery: needs reply",
    build: () => ({ sessions: pick(["gallery/plan", "gallery/question"]), events: [] }),
  },
  {
    id: "gallery-bubble",
    label: "Gallery: bubbles",
    build: () => ({ sessions: pick(["gallery/finished", "gallery/done", "gallery/tested"]), events: [] }),
  },
];

export const DEFAULT_PRESET = PRESETS[1];

function tr(en: string, ja: string): string {
  return uiLanguage().toLowerCase().startsWith("ja") ? ja : en;
}

const GALLERY: SessionView[] = [
  { id: "gallery/plan", project: "blog", slug: "blog", state: "waiting", sinceMs: 70_000, toolName: "ExitPlanMode" },
  { id: "gallery/working", project: "tomarigi", slug: "tomarigi", state: "working", sinceMs: 3_000 },
  {
    id: "gallery/question",
    project: "tomarigi",
    slug: "tomarigi",
    state: "waiting",
    sinceMs: 30_000,
    toolName: "AskUserQuestion",
    question: tr("One panel or tabs?", "設定はタブに分ける？"),
  },
  {
    id: "gallery/finished",
    project: "figma-adapter",
    slug: "figma-adapter",
    state: "done",
    sinceMs: 5_000,
    ask: { status: "not_asking" },
    summary: tr("Added three button sizes", "ボタンを 3 種類にした"),
  },
  {
    id: "gallery/done",
    project: "moh-tech-net",
    slug: "moh-tech-net",
    state: "done",
    sinceMs: 2 * 60_000,
    ask: { status: "not_asking" },
    summary: tr("Fixed the README typo", "README の誤字を直した"),
  },
  {
    id: "gallery/tested",
    project: "tomarigi",
    slug: "tomarigi",
    state: "done",
    sinceMs: 40_000,
    ask: { status: "not_asking" },
    summary: tr("Wrote the settings tests", "設定のテストを書いた"),
  },
  {
    id: "gallery/dozing",
    project: "figma-adapter",
    slug: "figma-adapter",
    state: "dozing",
    sinceMs: 9 * 60_000,
    ask: { status: "not_asking" },
    summary: tr("Updated the build config", "ビルド設定を更新した"),
  },
];

function pick(ids: string[]): SessionView[] {
  return ids.map((id) => GALLERY.find((s) => s.id === id)!);
}
