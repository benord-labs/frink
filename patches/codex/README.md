# The bundled Codex patch

Frink ships a Codex built from a pinned upstream tag with one patch applied on top.

| File | What it is |
| --- | --- |
| `manifest.json` | The upstream tag, its archive hash, the Rust toolchain, and the patch's SHA-256. |
| `frink-host-tool-permission-v1.patch` | The patch. Generated — do not edit it by hand. |
| `thread-item-variants.json` | The upstream `ThreadItem` variants Frink has classified. |

`scripts/binaries/build-codex-frink.mjs` verifies all of it and builds the binary
(`bun run codex:build`).

## Changing the patch

The patch file is written by a tool, in one fixed format, from a git checkout of the patched
source. Edit the source, not the patch.

```bash
# 1. Lay the pinned source out as a git repository: upstream as one commit (tag frink-pristine),
#    the Frink patch as a second (tag frink-patched). The directory must be empty and outside
#    this checkout.
bun run codex:patch -- --prepare-source ~/codex-frink

# 2. Edit files under ~/codex-frink. Committing there is optional; uncommitted and new files count.

# 3. Run the provider regression tests against your edits.
bun run codex:patch -- --test-only ~/codex-frink

# 4. Regenerate the patch and its hash.
bun run codex:patch -- --write-patch ~/codex-frink
```

Step 4 rewrites the patch file and `patchSha256` in `manifest.json`, and nothing else. Commit both.
Run with no edits, it changes nothing; after one edit, only that file's section of the patch moves.

It prints every file that entered or left the patch. Read that list: anything you created in the
workspace that upstream's `.gitignore` does not cover is swept in, including leftovers such as
`*.snap.new` from a failing snapshot test. The reverse also holds: a new file at a path upstream
ignores cannot enter the patch, so it is listed separately (cargo's `target/` excepted).

A workspace only writes over the patch it was prepared from. If the committed patch has changed
since — you pulled, or someone wrote from another workspace or worktree — `--write-patch` refuses
rather than revert that change; prepare a fresh workspace and redo the edit there.
Two writes into the same checkout at once are refused too: each holds
`patches/codex/.write-patch.lock` while it runs. If a killed run left that file behind, delete it.

### One hash, one place

`patchSha256` lives only in `manifest.json`. The build refuses a patch file whose bytes do not match
it, and so does the test suite, so a hand edit to the patch fails fast.

The version stamp written beside the built binary includes that hash, and the app refuses a binary
whose stamp does not match. After any patch change, everyone rebuilds: `bun run codex:build`.
`bun run dev` warns when the local binary is stale.

### Tests

`--test-only` uses the same cargo target directory as the build (`~/.cache/frink-codex-target`, or
`CARGO_TARGET_DIR`), so it is incremental after the first run. The first run compiles the whole
workspace and can take an hour or more.

It rewrites placeholder versions in `codex-rs/Cargo.lock`, as the build does. `--write-patch`
ignores that change.

### Protocol and schema changes

About a quarter of the patch is generated upstream fixtures under
`codex-rs/app-server-protocol/schema/`, one of them a compressed binary. If you change the
app-server protocol types, regenerate them in the workspace before step 4:

```bash
cd ~/codex-frink && just write-app-server-schema
```

Upstream's own tests fail when the fixtures are out of date.

### Limits

- **No dependency changes.** The patch does not carry `Cargo.lock`. `--write-patch` stops if the
  lockfile differs from upstream in any way other than the version rewrite above.
- **Same upstream tag only.** Moving to a new upstream tag means re-pinning the rest of
  `manifest.json` and the matching constants in the build script, and rebasing the patch; this loop
  does not do that.
