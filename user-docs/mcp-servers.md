# MCP servers

MCP (Model Context Protocol) servers give your AI assistants extra tools, like "search Linear" or "spin up a Neon branch." Frink manages MCPs centrally so you configure them once and they're available across every chat and every provider (Claude, Codex) you use through Frink.

This guide explains how Frink imports MCPs from your existing tools, where they are stored, and how the day-to-day mechanics work.

## What is MCP?

MCP is an open protocol that lets AI assistants talk to external systems through a standard interface. An MCP server exposes a set of tools (functions the model can call), and the assistant decides when to invoke them mid-conversation. Examples: a GitHub MCP that exposes `create_pull_request`, a Postgres MCP that exposes `run_query`, a filesystem MCP that exposes `read_file`.

There are two common transports:

| Transport | Where it runs | When to use |
|---|---|---|
| **stdio** | Local process spawned by Frink | Most community MCPs (`npx`, `python`, etc.) |
| **HTTP / SSE** | Remote service or local app on `127.0.0.1` | Hosted MCPs (GitHub, Linear, Neon) and local apps (Figma, Sketch) |

Frink supports both.

## The short version

- Frink scans your existing Claude Code and Cursor MCP configs on every launch and imports them automatically.
- Once imported, Frink owns them. Everything is stored on this computer.
- Native configs (`~/.claude.json`, `~/.cursor/mcp.json`) are left untouched. Your CLI tools keep working.
- Credentials are stored encrypted and never leave this computer.
- Delete an imported MCP from Frink and it stays deleted, even on reboot.

## Where Frink stores MCPs

Frink keeps two files in `~/.frink/mcp/`, and neither leaves this computer:

| File | Contents |
|---|---|
| `config.json` | Server definitions: name, command, args, URL, required env var keys, provenance |
| `credentials.json` | Encrypted env values, OAuth tokens, bearer headers |

`credentials.json` is encrypted using your operating system's secure credential store (macOS Keychain, Linux libsecret, Windows DPAPI). The encryption key is per-machine, so the file is meaningless if copied off the device.

## Auto-import on launch

Every time Frink starts, it scans:

1. `~/.claude.json` for Claude Code's global MCPs
2. `~/.cursor/mcp.json` for Cursor's global MCPs
3. `<project>/.cursor/mcp.json` for Cursor's per-project MCPs (one per Frink project)

For each MCP it finds, Frink either imports it (new) or skips it (already imported, by you, or tombstoned, see below). The import is **silent**: no confirmation prompt, no first-run summary screen. Open **Settings → Plugins → MCP servers** to see what landed.

Codex is a delivery target, but its native config is not an import source yet. During a Frink Codex chat, Frink replaces Codex's native MCP list with the project-filtered servers shown in **Settings → Plugins → MCP servers** and routes their tool calls through Frink permissions. Codex's own config is left untouched and still works in the standalone CLI; add a Codex-only server to Frink once if you want it available inside Frink. This separation also prevents Codex from opening its MCP Keychain item during Frink chats.

### What "imported" means

An imported MCP gets stamped with provenance: Frink remembers which native source it came from and when. That stamp is what lets Frink:

- Hide the duplicate native row in Settings (so you only see each MCP once)
- Skip the entry on the next boot scan (idempotent)
- Tombstone it if you delete it

User-created MCPs (added via the **Add server** button) have no provenance and are always Frink-owned.

### When the same MCP exists in two places

When the same MCP name appears in **both** `~/.claude.json` and `~/.cursor/mcp.json`, Frink doesn't try to merge or pick a winner. It imports a structural shell with **empty credentials** and surfaces "needs credentials" in Settings. You then enter the right token via **Configure** once.

For example: an MCP called `github` exists in both Claude and Cursor configs. After import, you'll see one `github` row in Frink Global with no credentials attached, even if both configs had the same `GITHUB_TOKEN`. Configure it once with the token you want.

The structural fields (command, args, URL, required env var keys) come from the first source Frink scans (Claude > Cursor global > Cursor per-project). If the two configs use different commands or args, Frink picks the first one. Manually editing afterward is the way out.

### Check for new servers

**Check for new servers** (in the ⋯ menu next to **Add server** in **Settings → Plugins → MCP servers**) re-runs the importer on demand. Use it when:

- You ran `claude mcp add ...` while Frink was already open
- You added an MCP to `~/.cursor/mcp.json` since launch

It's safe to click whenever, since the importer is idempotent.

## Adding your own MCP

If you want an MCP that isn't already in Claude or Cursor, add it directly in Frink. Open **Settings → Plugins → MCP servers** and click **Add server**. You'll need:

- **Name**: short identifier (e.g., `github`, `postgres`, `figma`)
- **Command**: the executable to run (e.g., `npx`, `python`, `node`)
- **Arguments**: space-separated, like CLI flags (e.g., `-y @modelcontextprotocol/server-github`)
- **Env vars**: key-value pairs the server needs at runtime (API tokens, etc.)

That covers stdio servers. For HTTP / SSE servers, click **Edit config file** in the ⋯ menu next to **Add server** and add the entry directly to `~/.frink/mcp/config.json`.

Every MCP row has an enabled toggle. Switching it off keeps the definition and credentials intact but stops Frink from connecting, useful when you want to silence a noisy server temporarily without losing its setup.

### Config shape reference

Frink stores MCPs in roughly the same shape Claude and Cursor use, with a few extra fields. Examples for the three common cases:

**Local stdio server (Node.js)**

```json
{
  "name": "github",
  "type": "custom",
  "authType": "env_var",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "requiredEnvVars": ["GITHUB_TOKEN"],
  "enabled": true
}
```

**Local stdio server (Python)**

```json
{
  "name": "internal-tools",
  "type": "custom",
  "authType": "none",
  "command": "python",
  "args": ["/Users/me/code/mcp/server.py"],
  "enabled": true
}
```

**Remote HTTP server**

```json
{
  "name": "neon",
  "type": "cloud_api",
  "authType": "bearer",
  "url": "https://mcp.neon.tech/mcp",
  "enabled": true
}
```

Credentials never go in `config.json`. Bearer tokens, OAuth, and env values live in `credentials.json` and are managed via **Configure** in the UI.

### Global vs project-scoped MCPs

An MCP is either available everywhere or only in certain projects:

- **Global**: the MCP is available in every chat, every project. Server definition lives at the top of `config.json` under `servers`. Every MCP you add in Frink is global.
- **Project-scoped**: the same global server definition is *enabled* only for specific projects. Frink tracks this in `config.projects[<projectPath>].mcps` as a list of names.

Frink sets project scope for you in one case: MCPs it imports from a project's own Cursor file (`<project>/.cursor/mcp.json`) are enabled for that project only. There is no button for changing scope. To do it by hand, click **Edit config file** in the ⋯ menu next to **Add server** and edit the `projects` section of `~/.frink/mcp/config.json`.

### Config placeholders

When importing from any native config (Claude or Cursor), Frink resolves `${VAR}` placeholders against your shell environment at import time:

```json
"env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
```

- If `GITHUB_TOKEN` is set in the environment Frink runs in, the resolved value is stored in your encrypted credentials and the key drops out of the "needs configuration" list.
- If it's unset, the key shows up in **Settings → Plugins → MCP servers** as a missing credential, and you fill it in via **Configure**.

This only applies to import-time. MCPs added directly via Frink's UI take literal values.

## Tombstones (delete and stay deleted)

If you delete an imported MCP from Frink's UI, Frink writes a tombstone to `~/.frink/mcp/config.json`. Tombstones are checked at boot **before** the import, so even though the entry still exists in `~/.claude.json` or `~/.cursor/mcp.json`, Frink won't re-import it.

Tombstones are scoped to the MCP name. If you later add a different MCP with the same name (whether through Frink's UI or in a different native source), the tombstone clears automatically.

## Credentials: per-machine, by design

When Frink imports an MCP from Claude or Cursor, it copies the credential values into `~/.frink/mcp/credentials.json` and encrypts them. **Those encrypted values never leave the machine.**

This is intentional: the encryption key belongs to this computer, and your API keys never travel anywhere.

## Editing and rotating credentials

To rotate a token or change config, open **Settings → Plugins → MCP servers**, click the MCP, and use **Configure**. Frink writes the new value atomically and serializes it against the importer, so even if the importer happens to run mid-edit, your save won't be lost.

If you'd rather edit JSON directly, **Edit config file** (in the ⋯ menu next to **Add server**) opens `~/.frink/mcp/config.json` in Frink's built-in editor. (Credentials live in a separate encrypted file and aren't editable from there.)

## Security considerations

MCP servers run code on your machine and call external services on your behalf. Before installing anything you didn't write yourself:

- **Verify the source.** Stick to MCPs from trusted publishers and well-known repositories. Treat random GitHub forks like you would any other binary.
- **Review what it touches.** Read the server's README to understand which APIs it hits and what data it sees.
- **Use scoped tokens.** Where the upstream service supports it, generate API tokens with the minimum permissions the server actually needs (read-only over read-write, single-repo over org-wide, etc.).
- **Audit before integrating sensitive systems.** If an MCP is going to read production data or write to source control, skim its source before approving it.

Frink doesn't sandbox MCP servers. The same trust boundary you apply to a shell script applies here.

## What happens on Linux without a keyring

On Linux distros without a system keyring service installed (no `gnome-keyring` or `kwallet`), Frink can't encrypt credentials securely. In that case, Frink imports the **structural shells only**. No credentials persist. The MCPs show as "needs credentials" until you install a keyring service and re-enter values. Frink logs the situation once at boot rather than crashing or silently overwriting your existing credentials file.

## FAQ

**Q: I deleted an MCP and rebooted. Will it come back?**
No. The tombstone blocks re-import even though the native config still has the entry.

**Q: I added an MCP to `~/.claude.json` while Frink was open. How do I get it?**
Click **Check for new servers** in the ⋯ menu next to **Add server** in Settings → Plugins → MCP servers, or restart Frink. Either way, the import is idempotent.

**Q: I edited an imported MCP. Will Frink overwrite my changes on next boot?**
No. The importer skips entries that already exist with matching provenance, so your edits stay.

**Q: I have the same MCP in Claude and Cursor. Will Frink merge them if the credentials match?**
No. Frink dedups by name only and never compares credentials. Even if both configs hold an identical token, Frink imports a structural shell with empty credentials. Re-enter once via Configure and you're set.

**Q: Can I temporarily disable an MCP without deleting it?**
Yes. Open the MCP's row and click **Turn off**. That keeps the definition and credentials intact but stops Frink from connecting to it. Click **Turn on** whenever you want it back.

**Q: Should I use Frink for MCPs that handle sensitive data?**
The data flow is: the MCP server runs locally, talks to whatever upstream service it integrates with, and returns results into your chat. Frink stores the definition (server name, command, URL) and the encrypted credentials on this computer. If your concern is "is my OAuth token traveling through Frink's cloud?", the answer is no. If your concern is "is this third-party MCP server trustworthy with my data?", that's about the server itself, not Frink.

**Q: I see a `frink` entry in my `~/.claude.json`. Why doesn't it show in Settings?**
Frink injects that entry so Claude Code can talk back to Frink's own tools. It's deliberately filtered out of the import scan since Frink already manages it internally. Don't delete it manually, or your Claude sessions lose access to Frink's tooling. Frink's read-only and infrastructure tools are trusted and run silently; tools that change your Flows go through the standard permission prompt like any other MCP tool — with "always allow" options, honored deny rules, and no prompt at all when Auto Mode is on.

**Q: I'm offline. Will the importer still work?**
Yes. The importer only reads and writes files on this computer: new entries go to `~/.frink/mcp/config.json` and credentials are encrypted as usual.

**Q: An MCP is imported but not working in chat. How do I debug?**
Check the MCP's row in **Settings → Plugins → MCP servers**. If the status shows "needs credentials" or "needs auth", click **Configure** and add the missing token or run the OAuth flow. If it's "connected" but tool calls fail, the server itself is hitting an error (expired token, network issue, upstream API down). The Reconnect button on the row forces a re-probe and surfaces the underlying error. As a last resort, **Edit config file** (in the ⋯ menu next to **Add server**) lets you inspect the raw config; the credentials file is intentionally not editable from the UI.
