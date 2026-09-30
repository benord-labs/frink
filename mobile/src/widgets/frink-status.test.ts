import { isValidElement, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import type { LiveActivityEnvironment, LiveActivityLayout } from 'expo-widgets';
import type { MobileAgentCounts } from '@frink/shared/types/remote/mobile';

// Plain stand-ins for the SwiftUI views, so the layout can be read as a tree of props.
vi.mock('@expo/ui/swift-ui', () => {
  const view = (name: string) => Object.assign(() => null, { displayName: name });
  return Object.fromEntries(
    ['HStack', 'VStack', 'Image', 'Spacer', 'Text'].map((name) => [name, view(name)]),
  );
});
vi.mock('@expo/ui/swift-ui/modifiers', () =>
  Object.fromEntries(
    [
      'activityBackgroundTint',
      'background',
      'clipShape',
      'contentTransition',
      'font',
      'foregroundStyle',
      'frame',
      'lineLimit',
      'monospacedDigit',
      'padding',
      'resizable',
    ].map((name) => [name, () => ({ name })]),
  ),
);
vi.mock('expo-widgets', () => ({ createLiveActivity: (_name: string, layout: unknown) => layout }));
const { default: widget } = await import('./frink-status');
const layout = widget as unknown as (
  counts: MobileAgentCounts,
  env: LiveActivityEnvironment,
) => LiveActivityLayout;

const dark: LiveActivityEnvironment = { colorScheme: 'dark' };

/** Every string a region renders, and the asset names of its images. */
function read(node: ReactNode): { text: string; assets: string[] } {
  const text: string[] = [];
  const assets: string[] = [];
  const walk = (value: ReactNode) => {
    if (typeof value === 'string' || typeof value === 'number') text.push(String(value));
    else if (Array.isArray(value)) value.forEach(walk);
    else if (isValidElement<{ children?: ReactNode; assetName?: string }>(value)) {
      if (value.props.assetName) assets.push(value.props.assetName);
      walk(value.props.children);
    }
  };
  walk(node);
  return { text: text.join(' '), assets };
}

it('agrees the verb with the count', () => {
  expect(read(layout({ running: 0, needsYou: 1 }, dark).banner).text).toContain('needs you');
  const two = read(layout({ running: 3, needsYou: 2 }, dark).banner).text;
  expect(two).toContain('need you');
  expect(two).not.toContain('needs you');
});

it('says nothing is running at 0/0 rather than claiming success', () => {
  const { text } = read(layout({ running: 0, needsYou: 0 }, dark).banner);
  expect(text).toContain('Nothing running');
  expect(text).not.toMatch(/done|finished/i);
});

it('carries the Frink mark on the Lock Screen, in the island and on its own at 0/0', () => {
  const regions = layout({ running: 2, needsYou: 0 }, dark);
  expect(read(regions.banner).assets).toContain('FrinkMark');
  expect(read(regions.compactLeading).assets).toContain('FrinkMark');
  expect(read(regions.expandedLeading).assets).toContain('FrinkMark');
  expect(read(regions.minimal).text).toBe('2');
  expect(read(layout({ running: 0, needsYou: 0 }, dark).minimal).assets).toEqual(['FrinkMark']);
});

it('leads the island with what needs you', () => {
  const regions = layout({ running: 3, needsYou: 1 }, dark);
  expect(read(regions.compactTrailing).text).toBe('1');
  expect(read(regions.minimal).text).toBe('1');
});

it('says the card may be out of date once the Mac has gone quiet', () => {
  const regions = layout({ running: 1, needsYou: 0 }, { ...dark, isStale: true });
  expect(read(regions.banner).text).toContain('May be out of date');
  expect(read(regions.expandedBottom).text).toContain('May be out of date');
});

it('leads the Lock Screen card with the app icon tile, like the notifications beside it', () => {
  const banner = JSON.stringify(layout({ running: 1, needsYou: 0 }, dark).banner);
  expect(banner).toContain('"clipShape"');
  expect(banner).toContain('"background"');
});
