import log from 'electron-log';
import { z } from 'zod';
import { captureMainException } from '../../../sentry/init';
import { withTimeout } from '../../../platform/with-timeout';
import { CODEX_LOCKED_CONFIG_KEYS } from '../spawn-args';

/** Managed Codex policy silently beats launch flags (a multi_agent_v2 pin beats agents.enabled=false). */
export type LaunchLocks = { features: string[]; config: [key: string, value: string][] };

type Params = { cursor?: string; cwd?: string };
/** Each reply is still parsed: the type only names what the two reads return. */
type Reply = z.input<typeof featurePage> | z.input<typeof configRead>;
type Connection = { sendRequest(method: string, params: Params): Promise<Reply> };
type Request = Connection['sendRequest'];
type CodexConfig = z.infer<typeof configRead>['config'];

/** Each read; a cold server loads its config layers first. */
const READ_TIMEOUT_MS = 10_000;

/** The locks in `args` as spawned: every `--disable` feature and every locked `--config` value. */
export function launchLocks(args: readonly string[]): LaunchLocks {
  const features = new Set<string>();
  const config = new Map<string, string>();
  args.forEach((arg, index) => {
    const value = args[index + 1];
    if (value === undefined) return;
    if (arg === '--disable') features.add(value);
    if (arg !== '--config') return;
    const eq = value.indexOf('=');
    const key = value.slice(0, eq);
    if (eq > 0 && CODEX_LOCKED_CONFIG_KEYS.has(key)) config.set(key, value.slice(eq + 1));
  });
  return { features: [...features], config: [...config] };
}

const featurePage = z.object({
  data: z.array(z.object({ name: z.string(), enabled: z.boolean() })),
  nextCursor: z.string().nullish(),
});
const configRead = z.object({ config: z.record(z.string(), z.unknown()) });

/** What a non-developer is told each surface does; the raw key is kept for whoever manages Codex. */
const SURFACE_LABELS: [prefix: string, label: string][] = [
  ['multi_agent', 'helper agents'],
  ['agents.', 'helper agents'],
  ['computer_use', 'computer control'],
  ['code_mode', 'code mode'],
  ['shell_environment_policy.', 'passing your saved keys and passwords to the commands it runs'],
];

function surfaceLabel(setting: string): string {
  return SURFACE_LABELS.find(([prefix]) => setting.startsWith(prefix))?.[1] ?? setting;
}

/** Managed Codex policy turned a surface back on that Frink launched switched off. */
export class CodexSettingsOverriddenError extends Error {
  constructor(readonly settings: string[]) {
    const surfaces = [...new Set(settings.map(surfaceLabel))].join(' and ');
    super(
      `Codex settings managed on this computer or by your organisation turn on ${surfaces}, which ` +
        `Frink can't check before they act, so Frink won't run Codex chats here. Ask whoever ` +
        `manages Codex to change ${settings.map((s) => `\`${s}\``).join(', ')}, or pick a ` +
        `different model provider.`,
    );
    this.name = 'CodexSettingsOverriddenError';
  }
}

/** Codex's effective settings could not be read, so the locks are unconfirmed. */
export class CodexSettingsUncheckedError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(
      "Frink couldn't confirm Codex's settings before starting, so it didn't run this chat. " +
        'Send your message again to try again.',
      options,
    );
    this.name = 'CodexSettingsUncheckedError';
  }
}

async function effectiveFeatures(request: Request): Promise<Map<string, boolean>> {
  const enabled = new Map<string, boolean>();
  const seen = new Set<string>();
  let cursor: string | null | undefined;
  do {
    const page = featurePage.parse(
      await request('experimentalFeature/list', cursor ? { cursor } : {}),
    );
    for (const feature of page.data) enabled.set(feature.name, feature.enabled);
    cursor = page.nextCursor;
    // Each read is timed out, but a cursor that never advances would loop forever.
    if (cursor && seen.has(cursor)) throw new Error(`Codex repeated feature page ${cursor}`);
    if (cursor) seen.add(cursor);
  } while (cursor);
  return enabled;
}

const scalar = z.union([z.boolean(), z.number(), z.string()]).transform(String);

/** The value at a dotted path, as its TOML literal (`false`), or undefined when unset. */
function configValue(config: CodexConfig, path: string): string | undefined {
  const schema = path
    .split('.')
    .reduceRight<z.ZodType<string>>(
      (inner, key) => z.object({ [key]: inner }).transform((node) => node[key]),
      scalar,
    );
  const read = schema.safeParse(config);
  return read.success ? read.data : undefined;
}

async function readOverrides(request: Request, locks: LaunchLocks, cwd?: string) {
  const [features, read] = await Promise.all([
    locks.features.length > 0 ? effectiveFeatures(request) : new Map<string, boolean>(),
    locks.config.length > 0
      ? request('config/read', { cwd }).then((result) => configRead.parse(result).config)
      : {},
  ]);
  const unread: string[] = [];
  const overridden: string[] = [];
  for (const feature of locks.features) {
    const enabled = features.get(feature);
    if (enabled === undefined) unread.push(feature);
    else if (enabled) overridden.push(feature);
  }
  for (const [key, expected] of locks.config) {
    const actual = configValue(read, key);
    if (actual === undefined) unread.push(key);
    else if (actual !== expected) overridden.push(key);
  }
  return { unread, overridden };
}

/** Refuse a Codex server whose effective settings differ from the locks it was launched with. */
export async function verifyLaunchLocks(
  connection: Connection,
  args: readonly string[],
  cwd?: string,
): Promise<void> {
  const locks = launchLocks(args);
  if (locks.features.length === 0 && locks.config.length === 0) return;
  const request: Request = (method, params) =>
    withTimeout(
      connection.sendRequest(method, params),
      READ_TIMEOUT_MS,
      `Codex ${method} timed out`,
    );
  let result: Awaited<ReturnType<typeof readOverrides>>;
  try {
    result = await readOverrides(request, locks, cwd);
  } catch (err) {
    throw new CodexSettingsUncheckedError({ cause: err });
  }
  if (result.overridden.length > 0) {
    log.warn('[Codex] managed settings override launch locks', { settings: result.overridden });
    throw new CodexSettingsOverriddenError(result.overridden);
  }
  if (result.unread.length > 0) {
    const cause = new Error(`Codex did not report locked settings: ${result.unread.join(', ')}`);
    throw new CodexSettingsUncheckedError({ cause });
  }
}

/** A failed read goes to Sentry; a policy refusal is expected, and a disposed server is no failure. */
export function reportLaunchLockFailure(
  err: Error,
  disposed: boolean,
  capture = captureMainException,
): void {
  if (disposed || !(err instanceof CodexSettingsUncheckedError)) return;
  capture(err.cause ?? err, { surface: 'codex-launch-locks' });
}
