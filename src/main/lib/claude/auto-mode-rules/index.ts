import fs from 'node:fs';
import path from 'node:path';
import type { Settings } from '@anthropic-ai/claude-agent-sdk';
import log from 'electron-log';
import { z } from 'zod';
import { frinkUserHome } from '../../platform/frink-home';

/** The literal that splices Claude's built-in list into a user's list at that position. */
const DEFAULTS = '$defaults';

const RuleList = z.array(z.string()).optional().catch(undefined);

/** The user's `autoMode` block, one key at a time: the CLI drops the WHOLE block (silently) when any
 * key has the wrong type, so a mistyped key is dropped here and the valid ones still reach Claude. */
const UserAutoModeRules = z.object({
  environment: RuleList,
  allow: RuleList,
  soft_deny: RuleList,
  hard_deny: RuleList,
  classifyAllShell: z.boolean().optional().catch(undefined),
});
type AutoModeRules = NonNullable<Settings['autoMode']>;
const AUTO_MODE_KEYS = [
  'environment',
  'allow',
  'soft_deny',
  'hard_deny',
  'classifyAllShell',
] as const;

/** The settings file's own shape is not Frink's to judge; only the keys Frink delivers are read. */
const SettingsFile = z
  .object({ autoMode: z.unknown(), crossSessionInbound: z.unknown() })
  .partial();
const AutoModeBlock = z.record(z.string(), z.unknown());

/** Dropped-key reports already made this process, so a bad file is reported once, not per spawn. */
const reportedDrops = new Set<string>();

function reportDropped(keys: string[], block = ' autoMode'): void {
  const signature = keys.join(',');
  if (reportedDrops.has(signature)) return;
  reportedDrops.add(signature);
  const message = `[claude] ~/.claude/settings.json${block}: ignored ${signature} (unreadable or not the type Claude expects)`;
  log.warn(message);
  // Lazy import keeps @sentry/electron out of this module's static graph, as session-config-dir does.
  void import('../../sentry/init')
    .then(({ captureMainException }) =>
      captureMainException(new Error(message), { surface: 'claude-auto-mode-rules' }),
    )
    .catch(() => {});
}

/** A block list the user wrote without `$defaults` would discard Claude's built-in blocks (force
 * push, `curl | bash`, data exfiltration) in unattended Flows, so Frink keeps them in front. */
function withBuiltInBlocks(list: string[] | undefined): string[] | undefined {
  if (!list || list.includes(DEFAULTS)) return list;
  return [DEFAULTS, ...list];
}

/** The rules Frink sends: the valid lists, with Claude's built-in blocks kept. */
function deliverable(rules: AutoModeRules): AutoModeRules | null {
  const result: AutoModeRules = {};
  for (const key of ['environment', 'allow'] as const) {
    if (rules[key]) result[key] = rules[key];
  }
  for (const key of ['soft_deny', 'hard_deny'] as const) {
    const list = withBuiltInBlocks(rules[key]);
    if (list) result[key] = list;
  }
  if (rules.classifyAllShell !== undefined) result.classifyAllShell = rules.classifyAllShell;
  return Object.keys(result).length > 0 ? result : null;
}

/** The `autoMode` block of the user's own ~/.claude/settings.json, which a chat's isolated config
 * dir hides. Never read from a project's settings: Claude itself refuses those for `autoMode`. */
export function readUserAutoModeRules(): Pick<Settings, 'autoMode'> {
  const settings = readUserSettingsFile();
  if (settings?.autoMode === undefined) return {};
  const block = AutoModeBlock.safeParse(settings.autoMode);
  if (!block.success) {
    reportDropped(['autoMode']);
    return {};
  }
  const rules = UserAutoModeRules.parse(block.data);
  const dropped = AUTO_MODE_KEYS.filter((key) => key in block.data && rules[key] === undefined);
  if (dropped.length > 0) reportDropped(dropped);
  const autoMode = deliverable(rules);
  return autoMode ? { autoMode } : {};
}

/** The user's own ~/.claude/settings.json, which a chat's isolated config dir hides. Unreadable, it
 * is reported once and Claude runs on its defaults, as it does in the terminal. */
function readUserSettingsFile(): z.infer<typeof SettingsFile> | null {
  const file = path.join(frinkUserHome(), '.claude', 'settings.json');
  if (!fs.existsSync(file)) return null;
  try {
    const settings = SettingsFile.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return settings.success ? settings.data : null;
  } catch {
    reportDropped(['settings.json'], '');
    return null;
  }
}

const CrossSessionInbound = z.enum(['accept', 'hold', 'refuse']);

/** Whether the user's other sessions may message this chat, as they set it for the terminal
 * (`/config` writes it to ~/.claude/settings.json). Unset, Claude decides per message. */
export function readUserCrossSessionInbound(): Pick<Settings, 'crossSessionInbound'> {
  const value = readUserSettingsFile()?.crossSessionInbound;
  if (value === undefined) return {};
  const parsed = CrossSessionInbound.safeParse(value);
  if (parsed.success) return { crossSessionInbound: parsed.data };
  reportDropped(['crossSessionInbound'], '');
  return {};
}

/** Test-only: forget which bad keys were already reported. */
export function _resetAutoModeRuleReportsForTests(): void {
  reportedDrops.clear();
}
