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
- `seed-db.ts` / `fixtures/` — the deterministic fixture workspace (`fixtures/index.ts` seeds it).
- `use-fake-claude.sh` / `fake-bin/` — swaps the QA build's `claude` for a scripted fake that speaks the
  SDK protocol and answers fixed requests with no model call. Run after `build.sh`.
- `fixtures/background-work.ts` / `wake-background-chats.ts` — three seeded QA Fixture chats (long tests,
  a Workflow, three commands). After boot on the fake, `bun scripts/qa/wake-background-chats.ts` sends
  each its request so it holds live background work; that state is in memory, so wake after every boot.
