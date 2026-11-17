import type { Settings } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { hooksForLaunch } from '../../provider/hooks/store';
import type { resolveClaudeAutoMemorySettings } from '../auto-memory';
import {
  type AssertNone,
  CLAUDE_SETTINGS_CONTRACT,
  type ClaudeSettingRoute,
  type KnownKeys,
} from './index';

const ROUTES: ClaudeSettingRoute[] = [
  'delivered',
  'frink-owned',
  'native',
  'hidden-by-design',
  'inert-headless',
  'not-yet-delivered',
];
const { routes, reasons } = CLAUDE_SETTINGS_CONTRACT;
const keysRoutedAs = (route: ClaudeSettingRoute) =>
  Object.entries(routes)
    .filter(([, routed]) => routed === route)
    .map(([key]) => key)
    .sort();

// Checked by `ts:check`: what index.ts asserts for the SDK's keys must reject a key either way.
type SettingKey = KnownKeys<Settings>;
type WithoutHooks = Exclude<keyof typeof routes, 'hooks'>;
type WithUnknownKey = keyof typeof routes | 'notARealClaudeSetting';
// @ts-expect-error -- a Settings key the contract does not route fails
type _MissingKey = AssertNone<Exclude<SettingKey, WithoutHooks>>;
// @ts-expect-error -- a routed key Settings does not declare fails
type _ExtraKey = AssertNone<Exclude<WithUnknownKey, SettingKey>>;

// What the session spec spreads into the SDK's flag settings from the user's own config.
const DELIVERED = ['autoMemoryDirectory', 'autoMemoryEnabled', 'disableAllHooks', 'hooks'] as const;
type CarriedOver =
  | keyof Awaited<ReturnType<typeof hooksForLaunch>>
  | keyof ReturnType<typeof resolveClaudeAutoMemorySettings>;

describe('CLAUDE_SETTINGS_CONTRACT', () => {
  it('routes every key to a known route', () => {
    for (const [key, route] of Object.entries(routes)) {
      expect(ROUTES, key).toContain(route);
    }
  });

  it('records why each key is hidden by design, and nothing else', () => {
    expect(Object.keys(reasons).sort()).toEqual(keysRoutedAs('hidden-by-design'));
  });

  it('marks as delivered exactly what a chat carries over from ~/.claude', () => {
    expectTypeOf<(typeof DELIVERED)[number]>().toEqualTypeOf<CarriedOver>();
    expect(keysRoutedAs('delivered')).toEqual([...DELIVERED]);
  });
});
