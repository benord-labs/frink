import fs from 'node:fs/promises';
import path from 'node:path';
import type { Settings } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type {
  HookInventory,
  HookRegistration,
  HookSource,
} from '../../../../shared/types/hook-inventory';
import { resolveProjectPathFromWorktree } from '../../claude-config';
import { frinkUserHome } from '../../platform/frink-home';
import { classifyHook } from './classify';

type SdkGroup = NonNullable<Settings['hooks']>[string][number];

// Keyed by the SDK's matcher-group schema, so a key the SDK adds fails typecheck here.
const GROUP_FIELDS = {
  matcher: z.string().optional(),
  hooks: z.array(z.unknown()),
} satisfies Record<keyof SdkGroup, z.ZodType>;

// Groups stay loose and handlers unparsed: an unknown key must reach the classifier to be named.
const settingsSchema = z.object({
  disableAllHooks: z.boolean().optional(),
  hooks: z.record(z.string(), z.array(z.looseObject(GROUP_FIELDS))).optional(),
});
type HookSettings = z.infer<typeof settingsSchema>;

/** The three Claude settings files, lowest precedence first; a root that is the home lists once. */
function hookSourceFiles(rootPath: string): Pick<HookSource, 'scope' | 'file'>[] {
  const all: Pick<HookSource, 'scope' | 'file'>[] = [
    { scope: 'user', file: path.resolve(frinkUserHome(), '.claude', 'settings.json') },
    { scope: 'project', file: path.join(rootPath, '.claude', 'settings.json') },
    { scope: 'local', file: path.join(rootPath, '.claude', 'settings.local.json') },
  ];
  return all.filter((source, i) => all.findIndex((other) => other.file === source.file) === i);
}

/** Zod drops a `__proto__` key unseen, so a file that has one is invalid instead. */
function refuseProtoKey(key: string, value: unknown): unknown {
  if (key === '__proto__') throw new Error('It has a "__proto__" key, which cannot be read');
  return value;
}

async function readHookSettings(
  file: string,
): Promise<
  | { status: 'read'; settings: HookSettings }
  | { status: 'missing' }
  | { status: 'invalid'; detail: string }
> {
  try {
    // As Claude does: skip a byte-order mark, and read a blank file as one with no settings.
    const text = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
    const parsed = settingsSchema.safeParse(text.trim() ? JSON.parse(text, refuseProtoKey) : {});
    if (parsed.success) return { status: 'read', settings: parsed.data };
    const [issue] = parsed.error.issues;
    const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
    return { status: 'invalid', detail: `${where}${issue.message}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    return { status: 'invalid', detail: (error as Error).message };
  }
}

/** One registration per handler under every matcher group under every event key. */
function sourceRegistrations(
  { scope, file }: Pick<HookSource, 'scope' | 'file'>,
  settings: HookSettings,
  knownEvents: ReadonlySet<string>,
): HookRegistration[] {
  return Object.entries(settings.hooks ?? {}).flatMap(([event, groups]) =>
    groups.flatMap(({ matcher, hooks, ...extra }, group) =>
      hooks.map((handler, index) => ({
        id: `${scope}:${event}:${group}:${index}`,
        scope,
        file,
        event,
        ...(matcher === undefined ? {} : { matcher }),
        ...classifyHook({ event, knownEvents, extraGroupKeys: Object.keys(extra), handler }),
      })),
    ),
  );
}

/**
 * Every hook the Claude settings files register for a project, and whether Frink can run each.
 * A Frink-managed worktree reads its root checkout; any other path is read as given.
 */
export async function readHookInventory(
  projectPath: string,
  resolveRoot: (path: string) => string | null = resolveProjectPathFromWorktree,
): Promise<HookInventory> {
  const resolved = resolveRoot(projectPath);
  if (resolved === null) throw new Error(`Cannot resolve the root checkout of ${projectPath}`);
  const rootPath = path.resolve(resolved);
  // The SDK is ESM-only and the main bundle is CommonJS, so it loads on demand.
  const { HOOK_EVENTS } = await import('@anthropic-ai/claude-agent-sdk');
  const knownEvents = new Set<string>(HOOK_EVENTS);
  const sources: HookSource[] = [];
  const registrations: HookRegistration[] = [];
  let disableAllHooks = false;
  for (const source of hookSourceFiles(rootPath)) {
    const result = await readHookSettings(source.file);
    if (result.status !== 'read') {
      sources.push({ ...source, ...result });
      continue;
    }
    sources.push({ ...source, status: 'read' });
    disableAllHooks = result.settings.disableAllHooks ?? disableAllHooks;
    registrations.push(...sourceRegistrations(source, result.settings, knownEvents));
  }
  // An invalid file may have set the flag either way, so it never reads as "hooks are off".
  const readable = sources.every((source) => source.status !== 'invalid');
  return { rootPath, sources, disableAllHooks: readable && disableAllHooks, registrations };
}
