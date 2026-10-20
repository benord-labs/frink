# QA app — an isolated Frink build on a fixed fixture workspace

Boots a prebuilt Frink on its own profile and CDP port (9223), seeded with a deterministic workspace,
for you or an agent to drive by hand:

```
bash scripts/qa/build.sh && bash scripts/qa/seed.sh && bash scripts/qa/boot.sh
```

- `env.sh` — shared path constants (lock, QA userData), sourced by both. Never redeclare them.
  The rig-owned Frink home and log dir hang off `QA_USER_DATA` in `boot.sh`, so seed.sh's profile
  wipe already resets them.
- `build.sh` — `electron-vite build` into `out-qa/` (never the shared `out/`, which packaging reads),
  so a boot takes seconds instead of a dev compile.
- `seed.sh` — wipes the QA profile, seeds fixtures.
- `boot.sh` — takes the run lock, launches the PREBUILT app (`out-qa/main/index.js` directly) on an
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

## Component before/after screenshots

The rig runs one session at a time. To screenshot a single renderer component, use `component-shot.ts`
instead: it takes no lock and needs no build, so parallel sessions can each run it, on macOS, Linux and Windows.

```
bun scripts/qa/component-shot.ts \
  src/renderer/components/dialogs/settings-tabs/ProjectSettingsTab/ProjectWorktreeSettings/index.tsx \
  ProjectWorktreeSettings --props '{"projectId":"p1"}' \
  --trpc-fixture scripts/qa/fixtures/component-shot/project-worktree-settings.json
```

- It writes `before.png` (the commit your branch forked from `--base`, default `origin/main`) and `after.png`
  (your working tree, uncommitted changes included) to `--out`, or to a temp folder it prints.
- The base side is a read-only copy of that commit's sources in a temp folder, rendered with today's
  `node_modules`; it never registers a git worktree. A warning names `package.json`/`bun.lock` if they changed.
- `--trpc-fixture` is JSON keyed by procedure path (`"worktreeConfig.get": {...}`); each answer is returned
  whatever the input, as plain JSON (no `Date` or `Map`). Other options: `--props-file`, `--width 780`,
  `--scale 2`, `--theme dark|light`.
- Exit codes: `0` both shots written; `2` the component called a procedure the fixture does not answer
  (listed, so a loading state is never mistaken for the real one); `3` the component or export does not
  exist at the base, so only `after.png` was written; `1` anything else.
- It needs Google Chrome or Microsoft Edge installed, or a browser from `bunx playwright-core install chromium`.
- It renders the component alone, with the app's providers but not its parents, custom themes or
  `window.desktopApi`. For a whole screen, or behaviour that depends on parent components, use the rig.
