import { describe, expect, it } from 'vitest';
import {
  VENDOR_PLUGIN_PINS,
  vendorPluginPin,
  vendorPluginPinByName,
  vendorPluginSource,
} from './vendor-plugin-pins';

describe('VENDOR_PLUGIN_PINS', () => {
  it('never pins two packages under one name — the on-disk store is keyed by name alone (sc-2805)', () => {
    const names = Object.values(VENDOR_PLUGIN_PINS).map((pin) => pin.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps every name inside the command-block charset, since names prefix slash commands (sc-2799)', () => {
    for (const pin of Object.values(VENDOR_PLUGIN_PINS)) {
      expect(pin.name).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });

  it('resolves a pin by its catalog id', () => {
    expect(vendorPluginPin('notion')?.name).toBe('notion');
    expect(vendorPluginPin('nope')).toBeUndefined();
  });

  it('resolves the owner of a package name', () => {
    expect(vendorPluginPinByName('notion')?.marketplace).toBe('claude-plugins-official');
    expect(vendorPluginPinByName('nope')).toBeUndefined();
  });
  it('pins the official workflow packages with their real acquisition identity', () => {
    for (const id of [
      'clickup',
      'notion',
      'neon',
      'sentry',
      'posthog',
      'canva',
      'supabase',
      'vercel',
    ]) {
      const pin = vendorPluginPin(id);
      expect(pin?.name).toBe(id);
      expect(pin?.gitCommitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(vendorPluginSource(id)).toMatchObject({
        repo: pin?.payloadRepo,
        commit: pin?.gitCommitSha,
      });
    }
    expect(vendorPluginSource('neon')?.path).toBe('plugins/neon-postgres');
    expect(vendorPluginSource('canva')?.path).toBe('plugins/canva');
    expect(vendorPluginSource('nope')).toBeUndefined();
  });
});
