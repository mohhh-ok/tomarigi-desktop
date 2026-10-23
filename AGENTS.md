# Agent instructions

The design is in `docs/design.md`; how to build, test, and release is in `README.md` and `docs/release.md`.

## Handing work to other sessions

- Each session that changes code works in its own git worktree, `.claude/worktrees/<name>` on a branch `wt/<name>` made from the local `main`, never in the main checkout: the user keeps `bun run dev` running there.
- The session that hands out the work checks each commit it gets (type check and tests, run by itself) and merges it into the local `main` right away, without asking the user first. The user tries the app on `main`, so a change should reach it as soon as it is checked (the user: 「mainでかくにんしてるから、随時mainにはんえいさせてね」「るーるもそうするようにしゅうせいしておいて」「このrepoのるーるな」).
  - So a session doing the work commits in steps that each work on their own, reports each commit, and merges `main` into its branch before starting the next step.
  - A change to what the user sees is shown to the user (screenshots) after it is merged, not before.
- Push only when the user asks.
