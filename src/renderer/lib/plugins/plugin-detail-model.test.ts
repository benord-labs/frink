import { describe, expect, it } from 'vitest';
import type { ResolvedPlugin } from '../../../shared/integrations/plugins';
import { resolvePlugins } from '../../../shared/integrations/plugins';
import {
  bandChain,
  bandPrompts,
  flowStepPrompt,
  bandSummary,
  capabilityRowsInTier,
} from './plugin-detail-model';
import type { PluginCapabilityRow } from './plugin-view-model';

const CATALOG = [...resolvePlugins({ installations: [] })];

function plugin(id: string): ResolvedPlugin {
  const found = CATALOG.find((candidate) => candidate.definition.id === id);
  if (!found) throw new Error(`${id} missing from the catalog`);
  return found;
}

function withContents(
  base: ResolvedPlugin,
  contents: Partial<ResolvedPlugin['definition']['contents']>,
): ResolvedPlugin {
  return {
    ...base,
    definition: {
      ...base.definition,
      contents: { ...base.definition.contents, ...contents },
    },
  };
}

describe('bandChain', () => {
  it('leads with the first trigger and hands its id to Use in Flow', () => {
    const shortcut = plugin('shortcut');
    const chain = bandChain(shortcut);

    expect(chain?.[0]).toMatchObject({
      pluginId: 'shortcut',
      triggerId: shortcut.definition.contents.triggers[0]?.id,
      caption: 'When this happens',
    });
    expect(chain?.[1]).toMatchObject({ label: 'Frink', caption: 'Frink does this' });
  });

  it('omits the event slide when the plugin only has tools or actions', () => {
    expect(bandChain(withContents(plugin('shortcut'), { triggers: [] }))).toBeNull();
  });

  it('draws nothing for a package with neither triggers nor tools', () => {
    const empty = withContents(plugin('shortcut'), { triggers: [], mcpServers: [], actions: [] });
    expect(bandChain(empty)).toBeNull();
  });
});

describe('bandSummary', () => {
  it('joins the trigger sample, the tool count and the chat note', () => {
    expect(bandSummary(4, 1, false)).toBe('1 of 4 triggers · 1 tool below');
    expect(bandSummary(0, 3, true)).toBe('3 tools below · tools work in chats too');
    expect(bandSummary(1, 0, true)).toBe('');
  });
});

describe('capabilityRowsInTier', () => {
  const row = (id: string): PluginCapabilityRow => ({ id, label: id, items: [], emptyCopy: '' });
  const rows = [
    'works-in',
    'auth',
    'mystery',
    'skills',
    'version',
    'source',
    'triggers',
    'agent-tools',
    'accounts',
  ].map(row);

  it('files each row by tier in the page order, unknown ids landing in inventory', () => {
    const ids = (tier: Parameters<typeof capabilityRowsInTier>[1]) =>
      capabilityRowsInTier(rows, tier).map((entry) => entry.id);

    expect(ids('accounts')).toEqual(['accounts']);
    expect(ids('inventory')).toEqual(['agent-tools', 'triggers', 'skills', 'mystery']);
    expect(ids('fact')).toEqual(['source', 'version', 'auth']);
    expect(ids('matrix')).toEqual(['works-in']);
  });
});

describe('bandPrompts', () => {
  it.each(['clickup', 'vercel', 'neon'])(
    'puts the supported Flow action before general %s examples',
    (id) => {
      const entry = plugin(id);
      expect(bandPrompts(entry)[0]).toBe(flowStepPrompt(entry));
      expect(bandPrompts(entry).length).toBeGreaterThan(1);
    },
  );

  it('offers skill examples without tools or Flow actions', () => {
    const entry = withContents(plugin('supabase'), { triggers: [], mcpServers: [], actions: [] });
    expect(bandChain(entry)).toBeNull();
    expect(flowStepPrompt(entry)).toBeNull();
    expect(bandPrompts(entry).length).toBeGreaterThan(0);
  });

  it('derives examples from declared skills for packages without curated copy', () => {
    const entry = withContents(plugin('shortcut'), {
      triggers: [],
      mcpServers: [],
      actions: [],
      skills: [{ id: 'review', name: 'review', path: 'skills/review' }],
    });
    entry.definition = { ...entry.definition, id: 'custom-skills' };
    expect(bandPrompts(entry)).toEqual(['Use the review skill to help me with this project']);
  });

  it('does not offer curated chat prompts for a trigger-only package', () => {
    const entry = withContents(plugin('clickup'), { mcpServers: [], skills: [], actions: [] });
    expect(bandPrompts(entry)).toEqual([]);
  });
});
