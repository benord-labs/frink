# Worktree setup

When a chat runs in a **worktree** (an isolated git checkout so an agent can work without touching your main branch), Frink can run setup commands right after creating it — installing dependencies, copying env files, whatever your project needs to be immediately usable.

Get a chat into worktree mode with the **Local / Worktree** switcher next to the project picker, under the message box, when starting a new chat with a project selected.

Setup commands are configured per project. There's no setup by default: an unconfigured project just gets an empty worktree.

## Two different `.frink` paths

These sound alike but are unrelated:

| Path | What it is |
|---|---|
| `<project>/.frink/worktrees.json` | A **file in your project repo** listing the setup commands to run. Commit it so anyone who worktrees your project gets the same setup. |
| `~/.frink/worktrees/` | The **folder on your machine** where worktree checkouts themselves live (the base directory, overridable per project — see below). |

This page is about the first one.

## Configuring setup commands

Open **Settings → Projects → your project**. Under **Worktrees → Setup commands**, type each command into the empty last row; they run in order in the new worktree, right after it's created. Each row runs as its own command, so a `cd` in one row doesn't carry to the next — press **Shift+Enter** to put several lines in one row when they need to run together. Changes save automatically when you leave a field or press Enter.

Use `$ROOT_WORKTREE_PATH` to reference the main checkout — the usual case is copying env files that git won't track:

```json
{
  "setup-worktree": [
    "bun install",
    "cp $ROOT_WORKTREE_PATH/.env .env"
  ]
}
```

Settings saves this to `.frink/worktrees.json` at your project root, changing only the keys you edited, so anything else in the file is kept. To have an agent inspect the project and write the file for you, run `/worktree-setup` in a chat.

`setup-worktree` must be a list of strings. If Frink can't read the file — a typo, a trailing comma, or a single string instead of a list — Settings says so and won't save over it until you fix it.

If no config file is found, worktree creation is silent — no commands run, nothing is reported as missing. If the file exists but can't be read, setup is skipped and Frink logs that "couldn't read" message; Settings shows it too.

**Windows:** setup commands run through Git Bash (the one bundled with Git for Windows), so POSIX syntax like `cp` and `$VAR` works as shown above. If Git Bash isn't found next to your git install, commands silently fall back to `cmd.exe`, where that syntax doesn't run as written.

## Overriding where worktrees are created

By default worktrees are created under `~/.frink/worktrees/` (change that default in **Settings → Preferences**). The project's **Worktrees → Location** field puts that project's new worktrees somewhere else — leave it empty to use the default.

## Cursor's `.cursor/worktrees.json`

If you also use Cursor, note that Frink and Cursor do **not** share worktree setup config — Frink only reads `.frink/worktrees.json`, and won't pick up an existing `.cursor/worktrees.json` even though the two use the same `setup-worktree` key and `$ROOT_WORKTREE_PATH` variable. Keep both files if you use both tools; there's no import or merge between them today.
