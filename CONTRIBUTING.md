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
bun run test:run:coverage   # suite + coverage report
```

CI enforces the coverage floor on every pull request; the values live in
`scripts/testing/check-coverage-floor.mjs`. You don't need a full coverage run before committing:
run the tests for what you changed, and run the coverage form when you want to see the numbers.

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
