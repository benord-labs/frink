# QA app — an isolated Frink build on a fixed fixture workspace

Boots a prebuilt Frink on its own profile and CDP port (9223), seeded with a deterministic workspace,
for you or an agent to drive by hand:

```
bash scripts/qa/build.sh && bash scripts/qa/seed.sh && bash scripts/qa/boot.sh
bash scripts/qa/stop.sh    # from another shell: stops the app and frees the run lock
```

Each worktree can run its own instance at the same time. Give every script the same free port, for
example `FRINK_QA_PORT=40010 bash scripts/qa/seed.sh` and then `boot.sh`, `smoke.sh` or `stop.sh`
with it: that instance gets DevTools on that port, its own profile (`Frink Dev-40010`) and its own
run lock. Without it you get the default instance (port 9223). Run one instance per worktree,
because they share its `out-qa` build.

Check that the app boots healthy, in one command after `build.sh` (seeds, boots on the fake `claude`,
checks, always stops; prints one `qa smoke: PASS|FAIL` line, logs in `~/.frink-qa/smoke/`):

```
bash scripts/qa/smoke.sh
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
- `stop.sh` — stops the app `boot.sh` launched (it records the app pid in the lock), waits for the lock
  to be released, and kills the app after 10 s if it ignores SIGTERM. It also stops an app left running
  by a killed `boot.sh`, and is safe to run when nothing is up.
- `smoke.sh` / `smoke-check.ts` — the health check above. It fails when the window loaded anything but
  this checkout's `out-qa` renderer (a dev server leaked in), when a fixture login is flagged for
  re-auth, or when no chat composer appears.
- `screenshot.mjs` — `node scripts/qa/screenshot.mjs <out.png> [--width 1280] [--height 800]` saves the
  running app's window at a fixed size.

## Before/after screenshots for a PR

For a change that alters what users see, put before and after screenshots in the PR description. For a
single component, use `component-shot.ts` (below): it needs no rig lock and no build. For a whole
screen, or behaviour that depends on parent components, use the rig:

1. In a checkout of the PR's base branch: `build.sh`, `seed.sh`, `boot.sh &`, drive the app to the
   affected screen over CDP on :9223, then `node scripts/qa/screenshot.mjs before.png` and `stop.sh`.
2. Repeat in your branch's checkout for `after.png`, at the same size and on the same screen. The
   fixtures use fixed ids and timestamps, so the two boots differ only by your change.
3. Commit the PNGs to an orphan branch (`git switch --orphan pr-assets/<slug>`, add only the images,
   push it): GitHub has no API for attaching images to a PR.
4. Embed them by that commit's sha, side by side, and say which screen and size they show:
   `<img src="https://raw.githubusercontent.com/benord-labs/frink/<sha>/before.png" width="320">`

If nothing visible changed, say so in the PR description instead. A `.env` is optional: without one
the app has no backend URLs or keys, but it boots, passes `smoke.sh` and renders local screens.

### One component, without the rig

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
- Publish `before.png` and `after.png` the same way as steps 3 and 4 above.
