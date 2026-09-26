/**
 * Frink skill provisioning.
 *
 * Bundles Frink-owned skills (currently `frink-flows`) and installs them at
 * `~/.frink/skills/<name>/` on boot, then projects REAL COPIES into the per-tool
 * skill dirs (`~/.agents/skills`, `~/.claude/skills`, `~/.cursor/skills`) so
 * IDE-spawned agents can discover them.
 */

export * from './skill-provisioner';
