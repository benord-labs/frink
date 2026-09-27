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

## Tests

```bash
bun run test:run            # full suite
bun run test:run:coverage   # suite + coverage gate
```

Coverage thresholds live in `vitest.config.ts`: 65% statements, 63% functions. Use the coverage
form for anything that changes behaviour; `test:run` is enough for docs and config.

## Committing

There is no commit hook. CI runs the structure lint, type check, knip, the skill-content drift check
and the test suite on every pull request (`.github/workflows/test-suite.yml`); run them locally
before you push.

## Third-party and proprietary code

- Never copy, vendor, translate line by line, or cite source that is leaked or has no licence
  allowing reuse. That includes the Claude Code source exposed through an npm source map in March
  2026. Derive behaviour from public documentation (docs.claude.com, code.claude.com) or from what
  the released CLI observably does.
- Code taken from a permissively licensed project keeps its licence notice and gets an entry in
  `THIRD_PARTY_LICENSES.md`.
- The same rule binds AI coding agents: do not point an agent at a leaked or unlicensed checkout as
  reference material.

## Pull requests

Keep each PR small and single-purpose — under ~500 lines of diff. Out-of-scope work you find along
the way belongs in a follow-up issue, not in the same branch.

## Where things live

- `user-docs/` — end-user guides.

## Conduct

[GitHub's community guidelines](https://docs.github.com/site-policy/github-terms/github-community-guidelines)
apply.
