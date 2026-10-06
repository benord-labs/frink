# Contributing

## Prerequisites

- [Bun](https://bun.sh) — package manager and script runner. Do not use `npm`.
- Node 22.12+ — the local store uses Node's built-in `node:sqlite`.
- Git.

## Setup

```bash
git clone https://github.com/benord-labs/frink.git
cd frink
bun install
bun run claude:download     # vendored Claude CLI
bun run electron:download   # electron@43 has no install script
bun run dev
```

`bun install` itself needs no token.

`bun run dev` hot-reloads the renderer; main-process and preload changes need a restart.
`bun run dev:watch` relaunches the app on those changes instead, which ends any chats running in it.

## Tests

```bash
bun run test:run            # full suite
bun run test:run:coverage   # suite + coverage gate
```

Coverage thresholds live in `vitest.config.ts`: 65% statements, 63% functions. Use the coverage
form for anything that changes behaviour; `test:run` is enough for docs and config.

The app's renderer is built with the React Compiler; tests are not, unless the file is named
`*.compiled.test.ts` or `.tsx` under `src/renderer` (`bun run test:compiled` runs only those). Put any assertion about render
counts or object identity in a compiled test file, because the compiler changes exactly those
results. Count renders of the component itself, never of a mocked child, and include a case that must
raise the count. A compiled test still does not measure the running app: confirm a "renders less"
claim against the QA build (`scripts/qa/README.md`).

## Committing

There is no commit hook. CI runs the formatting check, oxlint, the structure lint, type check, knip,
the skill-content drift check and the test suite on every pull request
(`.github/workflows/test-suite.yml`); run them locally before you push. `bun run format` fixes
formatting, and `bun run lint` runs the format check, oxlint and the structure lint together.

## Pull requests

Keep each PR small and single-purpose — under ~500 lines of diff. Out-of-scope work you find along
the way belongs in a follow-up issue, not in the same branch.

## Where things live

- `user-docs/` — end-user guides.

## Conduct

[GitHub's community guidelines](https://docs.github.com/site-policy/github-terms/github-community-guidelines)
apply.
