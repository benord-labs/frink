import path from 'node:path';
import type { Settings } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
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

const TEXT = z.string();
/** Claude strips a key its schema does not define and runs the hook without it. */
const UNKNOWN_FIELD = 'Claude does not define it and runs the hook without it';
const NOT_YET = 'not supported by Frink yet';
const POWERSHELL: Reason = {
  code: 'field-unsupported',
  reason: `it runs in PowerShell, which is ${NOT_YET}`,
};
/** Claude itself refuses to run a settings hook that uses one of these plugin placeholders. */
const PLUGIN_ONLY = ['${CLAUDE_PLUGIN_ROOT}', '${CLAUDE_PLUGIN_DATA}'];

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
    v === 'powershell'
      ? POWERSHELL
      : unless(v === 'bash', 'malformed', 'its shell is neither "bash" nor "powershell"'),
  if: (v) => unless(TEXT.safeParse(v).success, 'malformed', 'its "if" is not text'),
  // The hooks reference: `once` is honoured only in skill frontmatter, ignored in settings files.
  once: (v) =>
    v === true
      ? { ignored: 'Claude honours it only in skill frontmatter, not in a settings file' }
      : unless(v === false, 'malformed', notFlag('once')),
  async: (v) =>
    v === true ? background('async') : unless(v === false, 'malformed', notFlag('async')),
  asyncRewake: (v) =>
    v === true
      ? background('asyncRewake')
      : unless(v === false, 'malformed', notFlag('asyncRewake')),
} satisfies Record<keyof SdkCommandHook, (value: unknown) => FieldRule>;

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

function notFlag(field: string): string {
  return `its "${field}" is not true or false`;
}

function background(field: string): Reason {
  return {
    code: 'async',
    reason: `it sets "${field}" to run in the background, which is ${NOT_YET}`,
  };
}

/** One reason per plugin placeholder in the command or its arguments, matched as Claude does. */
function pluginPlaceholderReasons(words: string[]): Reason[] {
  return PLUGIN_ONLY.filter((name) => words.some((word) => word.includes(name))).map((name) => ({
    code: 'provider-variable',
    reason: `it uses ${name}, which Claude fills in only for a plugin's own hooks`,
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
      : { ignored: UNKNOWN_FIELD };
    if (verdict === null) continue;
    if ('ignored' in verdict) ignored.push({ field, reason: verdict.ignored });
    // Claude does not read `shell` when `args` makes the hook exec form, which runs without one.
    else if (verdict === POWERSHELL && Object.hasOwn(raw, 'args')) {
      ignored.push({ field, reason: 'a hook with args runs without a shell' });
    } else reasons.push(verdict);
  }
  return [...reasons, ...pluginPlaceholderReasons(words)];
}

/** Why the handler itself cannot run, apart from where it is registered. */
function handlerReasons(raw: Record<string, unknown>, words: string[], ignored: Ignored): Reason[] {
  if (typeof raw.type !== 'string')
    return [{ code: 'malformed', reason: 'it has no handler type' }];
  if (raw.type === 'command') return commandReasons(raw, words, ignored);
  const what = Object.hasOwn(UNSUPPORTED_TYPES, raw.type)
    ? UNSUPPORTED_TYPES[raw.type as keyof typeof UNSUPPORTED_TYPES]
    : undefined;
  const reason = what
    ? `it ${what}, which is ${NOT_YET}`
    : 'it is a kind of handler Claude does not define';
  return [{ code: 'handler-type', reason }];
}

/** Every reason one handler cannot run in Frink, or that it runs as written. Pure. */
export function classifyHook(input: {
  event: string;
  knownEvents: ReadonlySet<string>;
  extraGroupKeys: string[];
  handler: unknown;
}): Pick<
  HookRegistration,
  'handlerType' | 'label' | 'command' | 'args' | 'if' | 'timeoutSec' | 'binding'
> {
  const raw = isPlainObject(input.handler) ? input.handler : {};
  const handlerType = typeof raw.type === 'string' && raw.type.trim() ? raw.type : 'unknown';
  const command = typeof raw.command === 'string' && raw.command.trim() ? raw.command : undefined;
  const args = isStringList(raw.args) ? raw.args : undefined;
  const words = command ? [command, ...(args ?? [])] : [];
  const label = hookLabel(handlerType, words);
  const ignored: Ignored = input.extraGroupKeys.map((field) => ({ field, reason: UNKNOWN_FIELD }));
  const reasons: Reason[] = [];
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
    if: TEXT.safeParse(raw.if).data,
    ...(isSeconds(raw.timeout) ? { timeoutSec: raw.timeout } : {}),
    binding: refusals.length ? { status: 'refused', refusals } : { status: 'supported', ignored },
  };
}
