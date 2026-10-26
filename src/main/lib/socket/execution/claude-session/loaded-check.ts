import fs from 'node:fs';
import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import matter from 'gray-matter';
import { z } from 'zod';
import {
  type LoadSet,
  reportStagedNotLoaded,
  STAGED_VS_LOADED_SURFACE,
  skillFolders,
} from '../../../provider/staged-vs-loaded';
import { captureMainException } from '../../../sentry/init';
import type { ClaudeSession } from '../../claude-session-registry';
import { noteSubagentTaskFrame } from '../../streaming';

// Not compared: hooks (init lists none), output style (Frink stages none), project files Claude reads.
// Hooks join `plugins` once they ship as a per-launch Frink plugin.

/** The parts of Claude's system/init this check reads. A CLI that predates a field leaves it out. */
type InitReport = {
  agents?: string[];
  skills?: string[];
  slash_commands?: string[];
  mcp_servers?: { name: string }[];
  plugins?: { name: string; source?: string }[];
};
type Snapshot = LoadSet & { configDir: string; projectRoot?: string };
const ClaudeSettings = z.object({
  enabledPlugins: z.record(z.string(), z.boolean()).optional(),
  skillOverrides: z.record(z.string(), z.string()).optional(),
});
type ClaudeSettings = z.infer<typeof ClaudeSettings>;
const pending = new WeakMap<ClaudeSession, Promise<Snapshot | null>>();

/** Snapshots what this spawn handed the CLI. The session's first system/init is checked against it. */
export function expectLoaded(
  session: ClaudeSession,
  spawn: Omit<Snapshot, 'plugins' | 'skills'>,
): void {
  pending.set(
    session,
    stagedInConfigDir(spawn.configDir).then(
      (staged) => ({ ...spawn, ...staged }),
      (error: Error) => {
        captureMainException(error, { surface: STAGED_VS_LOADED_SURFACE });
        return null;
      },
    ),
  );
}

/** One Claude settings file. A missing file is empty; any other read or parse error rejects. */
async function readSettings(file: string): Promise<ClaudeSettings> {
  const text = await fs.promises.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '{}';
    throw error;
  });
  return ClaudeSettings.parse(JSON.parse(text));
}

/** The plugins and user skills staged into a session's config dir. Any read error but ENOENT rejects. */
export async function stagedInConfigDir(configDir: string): Promise<LoadSet> {
  const [settings, skills] = await Promise.all([
    readSettings(path.join(configDir, 'settings.json')),
    skillFolders(path.join(configDir, 'skills')),
  ]);
  const plugins = Object.entries(settings.enabledPlugins ?? {}).flatMap(([id, on]) =>
    on ? [id] : [],
  );
  return { plugins, skills };
}

/** Claude reads YAML 1.1 booleans here: false, 0, no, off and n all hide a skill. */
const hiddenFromUsers = (value: boolean | number | string | null | undefined) =>
  /^(?:false|no|off|n|0)$/i.test(String(value).trim());

/** The project's own Claude settings, local over shared. An unreadable file counts as empty. */
async function projectSettings(projectRoot: string | undefined): Promise<ClaudeSettings> {
  if (!projectRoot) return {};
  const [shared, local] = await Promise.all(
    ['settings.json', 'settings.local.json'].map((file) =>
      readSettings(path.join(projectRoot, '.claude', file)).catch((): ClaudeSettings => ({})),
    ),
  );
  return {
    enabledPlugins: { ...shared?.enabledPlugins, ...local?.enabledPlugins },
    skillOverrides: { ...shared?.skillOverrides, ...local?.skillOverrides },
  };
}

/** Turned off by a project override other than 'on', or by its SKILL.md. Unreadable keeps it. */
async function skillTurnedOff(
  dir: string,
  name: string,
  project: ClaudeSettings,
): Promise<boolean> {
  const override = project.skillOverrides?.[name];
  if (override !== undefined && override !== 'on') return true;
  try {
    const text = await fs.promises.readFile(path.join(dir, 'skills', name, 'SKILL.md'), 'utf8');
    return hiddenFromUsers(matter(text).data['user-invocable']);
  } catch {
    return false;
  }
}

/** Staged names a reported category left out. */
const unlisted = (staged: string[] | undefined, loaded: string[] | undefined) =>
  loaded ? (staged ?? []).filter((name) => !loaded.includes(name)) : [];

/** Drops what the user turned off: a skill hidden by its own SKILL.md, or a project setting. */
async function withoutUserChoices(snapshot: Snapshot, loaded: LoadSet): Promise<LoadSet> {
  const skills = unlisted(snapshot.skills, loaded.skills);
  if (skills.length === 0 && unlisted(snapshot.plugins, loaded.plugins).length === 0) {
    return snapshot;
  }
  const project = await projectSettings(snapshot.projectRoot);
  const off = await Promise.all(
    skills.map((name) => skillTurnedOff(snapshot.configDir, name, project)),
  );
  const hidden = new Set(skills.filter((_, index) => off[index]));
  return {
    ...snapshot,
    skills: snapshot.skills?.filter((name) => !hidden.has(name)),
    plugins: snapshot.plugins?.filter((id) => project.enabledPlugins?.[id] !== false),
  };
}

/** The session reader's frame chokepoint: the sub-agent roster, then the first-init load check.
 * Total: a throw here would read as the stream dying. */
export function noteSessionFrame(session: ClaudeSession, frame: SDKMessage): void {
  noteSubagentTaskFrame(session.subChatId, frame);
  if (frame.type !== 'system' || frame.subtype !== 'init') return;
  const snapshot = pending.get(session);
  pending.delete(session);
  void snapshot
    ?.then(async (staged) => {
      if (!staged) return;
      const loaded = loadedFromInit(frame);
      const expected = await withoutUserChoices(staged, loaded);
      reportStagedNotLoaded('claude', session.subChatId, expected, loaded);
    })
    .catch((error: Error) => captureMainException(error, { surface: STAGED_VS_LOADED_SURFACE }));
}

/** What Claude says it loaded. Plugins are compared only when the CLI sends their `source`. */
export function loadedFromInit(init: InitReport): LoadSet {
  const { plugins, skills, slash_commands } = init;
  const sources = plugins?.flatMap((plugin) => plugin.source ?? []);
  return {
    agents: init.agents,
    mcpServers: init.mcp_servers?.map((server) => server.name),
    plugins: sources?.length === plugins?.length ? sources : undefined,
    skills: skills || slash_commands ? [...(skills ?? []), ...(slash_commands ?? [])] : undefined,
  };
}
