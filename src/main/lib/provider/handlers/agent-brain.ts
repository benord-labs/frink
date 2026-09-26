import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import log from 'electron-log';
import matter from 'gray-matter';
import { stringify as stringifyToml } from 'smol-toml';
import { TOOL_OPERATIONS } from '../../../../shared/types/permissions';
import { ensureDirExistsAsync } from '../../fs-helpers';
import type { CategoryHandler } from './types';
import { frinkUserHome } from '../../platform/frink-home';

/**
 * PCH-4 — project USER-GLOBAL custom-agent `.md` files across every tool's agent dir
 * (Codex gets TOML role files instead — see renderCodexRoleToml)
 * so an agent authored anywhere follows the user (the `portable-across-tools` promise:
 * name + instructions always come with you). Fan-out like skills — `ctx.provider` is
 * ignored; one delivery populates all dirs. Claude additionally receives agents
 * in-memory via the existing `getAllAgentsForSdk` path (untouched; its name-dedup
 * absorbs the projected copies).
 *
 * Projection is VERBATIM via gray-matter (every frontmatter key + byte-identical body
 * preserved — unlike `parseAgentMd`/`generateAgentMd`, which drop unknown keys), with
 * two exceptions:
 *  - `frinkProjected: true` is stamped so a copy is never re-read as a source
 *    (no amplification) and never mistaken for user-authored.
 *  - The TYPED fields `model`/`tools`/`disallowedTools` are omitted when the target
 *    tool family differs: Claude model ids (opus/sonnet/haiku) are invalid on Cursor
 *    (inherit/composer-2/…) and `tools:` names don't translate — the target tool
 *    falls back to its own defaults, per the user-doc's "relaxes to the closest thing
 *    that tool understands" carve-out. Tool-limit ENFORCEMENT is the allowlist
 *    vertical's job, not delivery's.
 *
 * Mirror semantics: a stamped projection is refreshed from its source on every
 * delivery — an edit made to the MIRROR is overwritten (edit the source instead; the
 * stamp marks which is which). Same-name agents authored in TWO dirs are never
 * merged or overwritten (clobber guard); the SDK's read priority picks the winner.
 */

/**
 * Field flavor per dir: `.frink` uses Claude-style typed fields (`VALID_AGENT_MODELS`).
 * `codex` is OpenAI Codex's `~/.codex/agents` role-file family: Codex loads only `*.toml` role
 * files there, so it is a projection TARGET only (see renderCodexRoleToml), never a `.md` source.
 */
export type AgentFlavor = 'claude' | 'cursor' | 'codex';
export type AgentDir = { dir: string; flavor: AgentFlavor };

/** Claude-style typed fields that don't translate to the other tool families. */
const CROSS_FLAVOR_OMIT = ['model', 'tools', 'disallowedTools'] as const;

/** Cursor-only fields that must not leak into a non-cursor copy (the reverse of CROSS_FLAVOR_OMIT). */
const CURSOR_FLAVOR_OMIT = ['readonly'] as const;

const MD_EXT = /\.md$/;

/**
 * First line of every Codex role file Frink writes. Codex's role schema rejects unknown keys, so
 * provenance is a comment rather than the `frinkProjected` field the `.md` mirrors carry.
 */
export const CODEX_PROJECTED_MARKER = '# frink-projected';

/** Discovery + projection targets, in the same priority order `getAllAgentsForSdk` reads. */
function agentDirs(): AgentDir[] {
  const home = frinkUserHome();
  return [
    { dir: path.join(home, '.claude', 'agents'), flavor: 'claude' },
    { dir: path.join(home, '.cursor', 'agents'), flavor: 'cursor' },
    { dir: path.join(home, '.codex', 'agents'), flavor: 'codex' },
    { dir: path.join(home, '.frink', 'agents'), flavor: 'claude' },
  ];
}

export type SourceAgent = {
  name: string;
  filename: string;
  data: Record<string, unknown>;
  body: string;
  from: AgentDir;
};

/** Collect one dir's user-authored agents into `byName` (first writer per name wins). */
async function collectAgentsFromDir(
  from: AgentDir,
  byName: Map<string, SourceAgent>,
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(from.dir);
  } catch {
    return; // dir doesn't exist on this machine
  }
  for (const filename of entries.filter((f) => f.endsWith('.md'))) {
    try {
      const { data, content } = matter(await fs.readFile(path.join(from.dir, filename), 'utf-8'));
      if (data.frinkProjected === true) continue; // our own mirror — never a source
      const name = typeof data.name === 'string' ? data.name : filename.replace(MD_EXT, '');
      if (!byName.has(name)) byName.set(name, { name, filename, data, body: content, from });
    } catch (err) {
      log.warn(`[provider] deliver:agentBrain unreadable ${filename}: ${String(err)}`);
    }
  }
}

/** User-authored agents across the `.md` dirs, deduped by frontmatter `name` (first dir wins). */
async function discoverUserAgents(dirs: AgentDir[]): Promise<SourceAgent[]> {
  const byName = new Map<string, SourceAgent>();
  for (const from of dirs) {
    if (from.flavor !== 'codex') await collectAgentsFromDir(from, byName);
  }
  return [...byName.values()];
}

/**
 * True when the agent declares a tools allowlist consisting ONLY of read-class
 * tools (per TOOL_OPERATIONS). Unknown tool names count as NOT read — fail open
 * to "no flag" so a coarse restriction is never over-claimed onto an agent that
 * might need more. No `tools` field = unrestricted = never readonly.
 */
function isDeclaredReadOnly(data: Record<string, unknown>): boolean {
  const tools =
    typeof data.tools === 'string'
      ? data.tools.split(',').map((t) => t.trim())
      : Array.isArray(data.tools)
        ? (data.tools as string[])
        : null;
  if (!tools || tools.length === 0) return false;
  return tools.every((t) => TOOL_OPERATIONS[t] === 'read');
}

/**
 * Mutate `data` in place with the cross-family field rules (target flavour already known to differ from
 * the source): degrade Claude tool-limits to Cursor's coarse `readonly` (logged), drop Claude-only typed
 * fields, and strip Cursor-only fields going to Claude. Order preserved so projectedMd stays byte-identical.
 */
function applyCrossFlavorRules(
  data: Record<string, unknown>,
  agent: SourceAgent,
  target: AgentDir,
): void {
  // The allowlist itself can't translate (PCH-5 enforces it at the Claude gate); on Cursor it DEGRADES to
  // the coarse native `readonly` switch when the agent declared itself read-only — the user-doc's "relaxes
  // to the closest thing that tool understands" promise. Both shapes are logged for the switch-time probe.
  if (target.flavor === 'cursor' && data.tools !== undefined) {
    if (isDeclaredReadOnly(agent.data)) {
      data.readonly = true;
      log.warn(
        `[provider] agent '${agent.name}': tool limits degrade to readonly on cursor (advisory)`,
      );
    } else {
      log.warn(
        `[provider] agent '${agent.name}': tool limits cannot degrade on cursor (advisory only — enforced in full on claude)`,
      );
    }
  }
  for (const key of CROSS_FLAVOR_OMIT) delete data[key];
  // Symmetric strip: Cursor-only fields (`readonly`) must not leak into any non-cursor copy.
  if (target.flavor !== 'cursor') for (const key of CURSOR_FLAVOR_OMIT) delete data[key];
}

/**
 * The document for a target flavor: verbatim body + frontmatter, with cross-family field rules applied
 * (see applyCrossFlavorRules). `stamp` adds the `frinkProjected:true` provenance marker — the auto-mirror
 * (deliverAgentBrain) sets it so a copy is never re-read as a source; a USER-initiated "copy across"
 * (copyUserAgent) passes `false` so the result is a plain user-owned file the mirror's clobber guard never
 * overwrites. SINGLE source for both paths. With `stamp=true` the output is byte-identical to the original
 * projectedMd.
 */
export function crossFlavorAgentMd(agent: SourceAgent, target: AgentDir, stamp: boolean): string {
  const data: Record<string, unknown> = stamp
    ? { ...agent.data, frinkProjected: true }
    : { ...agent.data };
  if (target.flavor !== agent.from.flavor) applyCrossFlavorRules(data, agent, target);
  return `${matter.stringify(agent.body, data).trimEnd()}\n`;
}

type CodexRole = { toml: string } | { skip: string };

/**
 * A Codex role file in the shape Codex's own Claude importer writes. Codex has no per-tool allowlist, so a
 * read-only agent maps to `sandbox_mode = "read-only"` and any other tool restriction is refused rather
 * than delivered unrestricted. Roles Codex would reject (no description or no instructions) are skipped.
 */
function renderCodexRoleToml(agent: SourceAgent): CodexRole {
  const { description } = agent.data;
  const instructions = agent.body.trim();
  if (typeof description !== 'string' || !description.trim()) return { skip: 'no description' };
  if (!instructions) return { skip: 'no instructions' };
  const readOnly = isDeclaredReadOnly(agent.data);
  const restricted = agent.data.tools !== undefined || agent.data.disallowedTools !== undefined;
  if (restricted && !readOnly) return { skip: 'tool limits Codex cannot enforce' };
  const role = {
    name: agent.name,
    description: description.trim(),
    ...(readOnly && { sandbox_mode: 'read-only' }),
    developer_instructions: instructions,
  };
  return { toml: `${CODEX_PROJECTED_MARKER}\n${stringifyToml(role)}\n` };
}

const isMdMirror = (text: string) => matter(text).data.frinkProjected === true;
const isCodexMirror = (text: string) => text.startsWith(CODEX_PROJECTED_MARKER);

/**
 * Write `content` to `dest` unless a user-authored file owns it (clobber guard) or it is already current.
 * Atomic: the temp name never ends in an extension a tool scans, so no reader sees a torn file.
 */
async function writeOwnMirror(
  dest: string,
  content: string,
  isOurs: (text: string) => boolean,
): Promise<boolean> {
  try {
    const existing = await fs.readFile(dest, 'utf-8');
    if (!isOurs(existing) || existing === content) return false;
  } catch {
    // dest does not exist — safe to write.
  }
  await ensureDirExistsAsync(path.dirname(dest));
  const tmp = `${dest}.frink-tmp`;
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, dest);
  return true;
}

/** Delete `file` only when it is one of Frink's own mirrors. */
async function removeOwnMirror(file: string, isOurs: (text: string) => boolean): Promise<void> {
  try {
    if (isOurs(await fs.readFile(file, 'utf-8'))) await fs.rm(file);
  } catch {
    // absent — nothing to remove.
  }
}

/** Project one agent as a Codex role; a refused agent also loses any earlier mirror of itself. */
async function projectCodexRole(agent: SourceAgent, dir: string): Promise<boolean> {
  const dest = path.join(dir, agent.filename.replace(MD_EXT, '.toml'));
  const role = renderCodexRoleToml(agent);
  if ('skip' in role) {
    log.warn(`[provider] agent '${agent.name}': not delivered to codex (${role.skip})`);
    await removeOwnMirror(dest, isCodexMirror);
    return false;
  }
  return writeOwnMirror(dest, role.toml, isCodexMirror);
}

/** Project one agent into one target dir. True = a file was written; false = skipped. */
async function projectAgentToDir(agent: SourceAgent, target: AgentDir): Promise<boolean> {
  if (target.flavor === 'codex') return projectCodexRole(agent, target.dir);
  const dest = path.join(target.dir, agent.filename);
  return writeOwnMirror(dest, crossFlavorAgentMd(agent, target, true), isMdMirror);
}

/** Codex never read the `.md` mirrors earlier releases wrote to its agents dir — delete them. */
async function removeLegacyCodexMdMirrors(dir: string): Promise<void> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  for (const f of entries.filter((e) => MD_EXT.test(e))) {
    await removeOwnMirror(path.join(dir, f), isMdMirror);
  }
}

export const deliverAgentBrain: CategoryHandler = async ({ mode }) => {
  const dirs = agentDirs();
  for (const d of dirs) if (d.flavor === 'codex') await removeLegacyCodexMdMirrors(d.dir);
  const agents = await discoverUserAgents(dirs);
  let written = 0;
  for (const agent of agents) {
    for (const target of dirs) {
      if (target.dir === agent.from.dir) continue;
      try {
        if (await projectAgentToDir(agent, target)) written += 1;
      } catch (err) {
        log.warn(
          `[provider] deliver:agentBrain skip ${agent.name} → ${target.dir}: ${String(err)}`,
        );
      }
    }
  }
  log.info(
    `[provider] deliver:agentBrain: ${agents.length} agent(s), ${written} projection(s) written`,
  );
  return {
    category: 'agentBrain',
    mode,
    status: 'delivered',
    detail: `projected ${agents.length} agent(s) (${written} write(s))`,
  };
};
