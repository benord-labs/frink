import path from 'node:path';
import vm from 'node:vm';
import type { HookEvent, HookInput } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { HookRegistration } from '../../../../shared/types/hook-inventory';
import { HOOK_EVENT_RULES } from './events';

/** A matcher of only these characters is a list of exact names; anything else is a regex. */
const NAME_LIST = /^[a-zA-Z0-9_|, -]+$/;
const NARROW_NAME_LIST = /^[a-zA-Z0-9_|]+$/;

/** Claude's former tool names, still accepted in a matcher. */
const LEGACY_NAMES = new Map([
  ['Task', 'Agent'],
  ['KillShell', 'TaskStop'],
  ['KillBash', 'TaskStop'],
  ['ListPeers', 'ListAgents'],
  ['Brief', 'SendUserMessage'],
  ['ListMcpResources', 'ListMcpResourcesTool'],
  ['ReadMcpResource', 'ReadMcpResourceTool'],
  ['ReadMcpResourceDir', 'ReadMcpResourceDirTool'],
]);

/** Settings regexes run in a separate realm that stops them after this long; it is wall-clock, so it is set far above any ordinary match. */
const REGEX_TIMEOUT_MS = 1000;
const REGEX_REALM = vm.createContext({});
const REGEX_TEST = new vm.Script('values.some((value) => new RegExp(matcher).test(value))');

/** What the event's matchers are tested against; undefined runs every group, as in Claude. */
function matcherValue(input: HookInput): string | undefined {
  if (input.hook_event_name === 'FileChanged') return path.basename(input.file_path);
  const field = HOOK_EVENT_RULES[input.hook_event_name].matcher;
  if (!field) return undefined;
  return z.object({ [field]: z.string() }).safeParse(input).data?.[field];
}

/** An unanchored regex; one too slow to decide selects the hook rather than skip it unseen. */
function regexMatches(matcher: string, values: string[]): boolean {
  try {
    RegExp(matcher);
  } catch {
    // Claude skips a group whose matcher is not a valid regex.
    return false;
  }
  try {
    const realm = Object.assign(REGEX_REALM, { matcher, values });
    return REGEX_TEST.runInContext(realm, { timeout: REGEX_TIMEOUT_MS }) === true;
  } catch {
    return true;
  }
}

/** Claude's matcher rules: match-all, a list of exact names, or an unanchored regex. */
function matcherMatches(event: HookEvent, matcher: string | undefined, value: string): boolean {
  if (!matcher || matcher === '*') return true;
  const narrow = HOOK_EVENT_RULES[event].narrowMatcher;
  if ((narrow ? NARROW_NAME_LIST : NAME_LIST).test(matcher)) {
    const names = matcher.split(/[|,]/).map((name) => name.trim());
    return names.some((name) => name && (LEGACY_NAMES.get(name) ?? name) === value);
  }
  const legacy = [...LEGACY_NAMES].filter(([, current]) => current === value);
  return regexMatches(matcher, [value, ...legacy.map(([name]) => name)]);
}

/** Claude's identity for a settings hook: the matcher, timeout and file do not count. */
function handlerKey(hook: HookRegistration): string {
  return [hook.command, JSON.stringify(hook.args ?? null), hook.if ?? ''].join('\0');
}

/** The bound hooks that run for one event, de-duplicated as Claude does. */
export function selectHooks(hooks: HookRegistration[], input: HookInput): HookRegistration[] {
  const event = input.hook_event_name;
  const value = matcherValue(input);
  const matched = hooks.filter(
    (hook) =>
      hook.event === event && (value === undefined || matcherMatches(event, hook.matcher, value)),
  );
  // Identical handlers run once: in the first one's place, with the last one's fields.
  return [...new Map(matched.map((hook) => [handlerKey(hook), hook])).values()];
}
