import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type {
  HookInventory,
  HookRegistration,
  HookSource,
} from '../../../../shared/types/hook-inventory';
import { frinkUserHome } from '../../platform/frink-home';

/** Whether a launch runs settings hooks; a hook Frink cannot run blocks the launch. */
export type HookBind =
  | { status: 'no-hooks' }
  | { status: 'ready'; hooks: HookRegistration[] }
  | { status: 'blocked'; reasons: string[] };

/** The most characters of settings-file text one part of a reason quotes. */
const SHOWN_CHARS = 300;
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;
/** Claude matches these against a canonical model name, which Frink cannot derive yet. */
const MODEL_EVENTS = new Set(['PreModelSwitch', 'PostModelSwitch']);
/** Matchers Claude runs on every model switch. */
const MATCH_ALL = new Set(['', '*', '.*']);

/** Text from a settings file made safe to show: no escape codes or invisible characters. */
function shown(text: string): string {
  const chars = Array.from(stripVTControlCharacters(text).replace(INVISIBLE, ' '));
  return chars.length > SHOWN_CHARS ? `${chars.slice(0, SHOWN_CHARS).join('')}…` : chars.join('');
}

function shownFile(file: string): string {
  const home = frinkUserHome();
  return shown(file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file);
}

function sourceReasons({ status, file, detail }: HookSource): string[] {
  if (status !== 'invalid') return [];
  return [`The Claude settings file ${shownFile(file)} cannot be read: ${shown(detail ?? '')}`];
}

/** Why Frink cannot run a hook its classifier accepted, if it cannot yet. */
function unsupported(hook: HookRegistration): string | undefined {
  if (hook.if) return 'its "if" filter is not supported by Frink yet';
  if (MODEL_EVENTS.has(hook.event) && !MATCH_ALL.has(hook.matcher ?? ''))
    return 'its model matcher is not supported by Frink yet';
  return undefined;
}

function hookReasons(hook: HookRegistration): string[] {
  const where = ` (${shownFile(hook.file)})`;
  if (hook.binding.status === 'refused') {
    return hook.binding.refusals.map(({ detail }) => shown(detail) + where);
  }
  const why = unsupported(hook);
  if (!why) return [];
  return [shown(`The ${hook.event} hook "${hook.label}" cannot run in Frink: ${why}.`) + where];
}

/**
 * The launch decision for a project's settings hooks. Unlike Claude, which skips a hook it
 * cannot load, Frink blocks the launch and names every hook and settings file at fault.
 */
export function bindHooks(inventory: HookInventory): HookBind {
  // The inventory never sets this while a settings file is invalid, so no fault is waived.
  if (inventory.disableAllHooks) return { status: 'no-hooks' };
  const reasons = [
    ...inventory.sources.flatMap(sourceReasons),
    ...inventory.registrations.flatMap(hookReasons),
  ];
  if (reasons.length) return { status: 'blocked', reasons };
  const hooks = inventory.registrations;
  return hooks.length ? { status: 'ready', hooks } : { status: 'no-hooks' };
}
