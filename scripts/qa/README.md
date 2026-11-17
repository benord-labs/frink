# QA app — an isolated Frink build on a fixed fixture workspace

Boots a prebuilt Frink on its own profile and DevTools port, seeded with a deterministic workspace,
for you or an agent to drive:

```
bash scripts/qa/build.sh && bash scripts/qa/seed.sh && bash scripts/qa/boot.sh
```

`boot.sh` runs in the foreground; Ctrl-C (or SIGTERM to it) stops the app and waits for it to exit.

Each worktree can run its own instance at the same time. Give `seed.sh` and `boot.sh` the same free
port, for example `FRINK_QA_PORT=40010`: that instance gets DevTools on that port and its own profile
(`Frink Dev-40010`). Without it you get the default instance (port 9223). Run one instance per
worktree, because they share its `out-qa` build, and don't re-seed an instance while it is running.

- `env.sh` — shared values (DevTools port, QA userData), sourced by both. Never redeclare them.
  The rig-owned Frink home and log dir hang off `QA_USER_DATA` in `boot.sh`, so seed.sh's profile
  wipe already resets them.
- `build.sh` — `electron-vite build` into `out-qa/` (never the shared `out/`, which packaging reads),
  so a boot takes seconds instead of a dev compile.
- `seed.sh` — wipes the QA profile, seeds fixtures.
- `boot.sh` — launches the PREBUILT app (`out-qa/main/index.js` directly) on an
  isolated port/profile — fails loudly if `build.sh` hasn't run yet.
- `scrub-host-env.sh` — sourced by `build.sh` and `boot.sh`: strips the host's electron-vite dev env
  (`ELECTRON_RENDERER_URL`, `NODE_ENV`, `VITE_*`, …) a Frink Dev agent shell carries, so the rig builds
  a production bundle and renders `out-qa`, not the host's dev server. boot.sh also sets
  `FRINK_QA_BUNDLE=1`, and main refuses to boot that bundle with a dev-server URL.
- `seed-db.ts` / `fixtures/` — the deterministic fixture workspace (`fixtures/index.ts` seeds it).
- The seeded Claude account (`QA Claude`) resolves through an empty marker file that `seed-db.ts` writes
  into the rig home, so the composer stays available without a Claude login on the machine. Because it
  always resolves, `boot.sh` runs the scripted fake `claude` by default: sends cost nothing. To run the
  real CLI on your own Claude login (and spend its quota), boot with `QA_REAL_CLAUDE=1 bash
  scripts/qa/boot.sh`. Either way, the first time the account resolves the app reads your
  `~/.claude.json` and stores that email on the fixture row, where Settings → Models shows it — keep
  that page out of screenshots you share.
- `use-fake-claude.sh` / `fake-bin/` — swaps the QA build's `claude` for a scripted fake that speaks the
  SDK protocol and answers fixed requests with no model call. `boot.sh` applies it on every boot.
- `use-real-claude.sh` — the reverse: links the checkout's real bundled CLIs back in. `boot.sh` runs it
  under `QA_REAL_CLAUDE=1`, and it refuses when the checkout has no bundled `claude`.
- `fixtures/background-work.ts` / `wake-background-chats.ts` — three seeded QA Fixture chats (long tests,
  a Workflow, three commands). After boot on the fake, `bun scripts/qa/wake-background-chats.ts` sends
  each its request so it holds live background work; that state is in memory, so wake after every boot.

## Screenshots for a PR

For a change that alters what users see, put screenshots in the PR description. Boot an instance,
drive it to the affected screen over DevTools on its port (any Chromium DevTools client works), and
capture the window there. The fixtures use fixed ids and timestamps, so two boots differ only by the
code they run. If nothing visible changed, say so in the PR description instead.

A `.env` is optional: without one the app has no backend URLs or keys, but it boots and renders local
screens.
