import path from 'node:path';
import type { Settings } from '@anthropic-ai/claude-agent-sdk';
import { isPlainObject } from '../../../../shared/lib/case-converter';
import type {
  HookBinding,
  HookRefusal,
  HookRegistration,
} from '../../../../shared/types/hook-inventory';

type SdkHook = NonNullable<Settings['hooks']>[string][number]['hooks'][number];
type SdkCommandHook = Extract<SdkHook, { type: 'command' }>;
type Reason = Pick<HookRefusal, 'code'> & { reason: string };
/** `null` means supported as written. */
type FieldRule = null | { ignored: string } | Reason;
type Ignored = Extract<HookBinding, { status: 'supported' }>['ignored'];

const BACKGROUND = 'a background hook cannot gate anything';

const UNSUPPORTED_TYPES = {
  prompt: 'asks Claude to judge a prompt',
  agent: 'starts a Claude verifier agent',
  http: 'posts to a URL',
  mcp_tool: 'calls an MCP tool',
} satisfies Record<Exclude<SdkHook['type'], 'command'>, string>;

// Keyed by the SDK's command-hook schema, so a field the SDK adds fails typecheck here.
const COMMAND_FIELD_RULES = {
  type: () => null,
  command: () => null,
  args: (v) => unless(isStringList(v), 'malformed', 'its args are not a list of strings'),
  timeout: (v) =>
    unless(isSeconds(v), 'malformed', 'its timeout is not a positive number of seconds'),
  statusMessage: (v) =>
    typeof v === 'string'
      ? { ignored: 'spinner text only; it changes nothing the hook decides' }
      : { code: 'malformed', reason: 'its statusMessage is not text' },
  shell: (v) =>
    unless(
      v === 'bash',
      'field-unsupported',
      'it sets "shell": Frink runs hooks with a POSIX shell',
    ),
  if: () => unless(false, 'field-unsupported', 'it sets "if", a filter Frink cannot evaluate'),
  once: (v) =>
    unless(v === false, 'field-unsupported', 'it sets "once": Frink does not track run-once hooks'),
  async: (v) => unless(v === false, 'async', `it sets "async": ${BACKGROUND}`),
  asyncRewake: (v) => unless(v === false, 'async', `it sets "asyncRewake": ${BACKGROUND}`),
} satisfies Record<keyof SdkCommandHook, (value: unknown) => FieldRule>;

const PROVIDER_VARIABLE = /\bCLAUDE_[A-Z0-9_]+/g;
const PROJECT_REF = /CLAUDE_PROJECT_DIR\}?"?\/[\w./@-]+/;
const SIMPLE_COMMAND = /^[\w./~-]+(?: +[\w@%+=:,./-]+)*$/;

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function unless(ok: boolean, code: Reason['code'], reason: string): Reason | null {
  return ok ? null : { code, reason };
}

/** `words` is the command and then its exec arguments; empty when there is no command. */
function hookLabel(handlerType: string, words: string[]): string {
  if (handlerType !== 'command' || !words.length) return `${handlerType} handler`;
  const ref = PROJECT_REF.exec(words.join(' '))?.[0];
  if (ref) return path.basename(ref);
  const text = words[0].trim();
  return SIMPLE_COMMAND.test(text) ? path.basename(text.split(' ', 1)[0]) : 'inline shell script';
}

/** One reason per `CLAUDE_` variable named, apart from the project directory. Matches by text. */
function providerVariableReasons(words: string[]): Reason[] {
  const names = new Set(words.join('\n').match(PROVIDER_VARIABLE));
  names.delete('CLAUDE_PROJECT_DIR');
  return [...names].map((name) => ({
    code: 'provider-variable',
    reason: `it uses ${name}, which only Claude provides`,
  }));
}

/** Why a command handler cannot run as written; fills `ignored` with the fields that are moot. */
function commandReasons(raw: Record<string, unknown>, words: string[], ignored: Ignored): Reason[] {
  const reasons: Reason[] = words.length
    ? []
    : [{ code: 'malformed', reason: 'it has no command' }];
  for (const [field, value] of Object.entries(raw)) {
    // hasOwn, not an index lookup: a key named `constructor` must not find a prototype member.
    const verdict: FieldRule = Object.hasOwn(COMMAND_FIELD_RULES, field)
      ? COMMAND_FIELD_RULES[field as keyof SdkCommandHook](value)
      : { code: 'field-unknown', reason: `it sets "${field}", which Frink does not know` };
    if (verdict === null) continue;
    if ('ignored' in verdict) ignored.push({ field, reason: verdict.ignored });
    else reasons.push(verdict);
  }
  return [...reasons, ...providerVariableReasons(words)];
}

/** Why the handler itself cannot run, apart from where it is registered. */
function handlerReasons(raw: Record<string, unknown>, words: string[], ignored: Ignored): Reason[] {
  if (typeof raw.type !== 'string')
    return [{ code: 'malformed', reason: 'it has no handler type' }];
  if (raw.type === 'command') return commandReasons(raw, words, ignored);
  const what = Object.hasOwn(UNSUPPORTED_TYPES, raw.type)
    ? UNSUPPORTED_TYPES[raw.type as keyof typeof UNSUPPORTED_TYPES]
    : 'is a kind Frink does not know';
  return [{ code: 'handler-type', reason: `it ${what}, and Frink only runs command hooks` }];
}

/** Every reason one handler cannot run in Frink, or that it runs as written. Pure. */
export function classifyHook(input: {
  event: string;
  knownEvents: ReadonlySet<string>;
  extraGroupKeys: string[];
  handler: unknown;
}): Pick<
  HookRegistration,
  'handlerType' | 'label' | 'command' | 'args' | 'timeoutSec' | 'binding'
> {
  const raw = isPlainObject(input.handler) ? input.handler : {};
  const handlerType = typeof raw.type === 'string' && raw.type.trim() ? raw.type : 'unknown';
  const command = typeof raw.command === 'string' && raw.command.trim() ? raw.command : undefined;
  const args = isStringList(raw.args) ? raw.args : undefined;
  const words = command ? [command, ...(args ?? [])] : [];
  const label = hookLabel(handlerType, words);
  const ignored: Ignored = [];
  const reasons: Reason[] = input.extraGroupKeys.map((key) => ({
    code: 'field-unknown',
    reason: `its matcher group sets "${key}", which Frink does not know`,
  }));
  if (!input.knownEvents.has(input.event)) {
    reasons.push({ code: 'event-unsupported', reason: 'Frink does not know that hook event' });
  }
  reasons.push(...handlerReasons(raw, words, ignored));
  const refusals = reasons.map(({ code, reason }) => ({
    code,
    detail: `The ${input.event} hook "${label}" cannot run in Frink: ${reason}.`,
  }));
  return {
    handlerType,
    label,
    command,
    ...(args ? { args } : {}),
    ...(isSeconds(raw.timeout) ? { timeoutSec: raw.timeout } : {}),
    binding: refusals.length ? { status: 'refused', refusals } : { status: 'supported', ignored },
  };
}
