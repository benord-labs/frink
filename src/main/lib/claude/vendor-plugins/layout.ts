/**
 * The vendor-plugin tree in one place: canonical store, per-runtime projections, marketplace mirrors.
 * The marketplace is provenance (staged.json, the claude-code id), never a path segment (sc-2805).
 */
import path from 'node:path';
import { frinkUserHome } from '../../platform/frink-home';

export type PluginCoords = { name: string; version: string };

/** Frink-owned root. The vendor/ tier is INERT: only projections are ever handed to a runtime. */
export function vendorPluginsRoot(): string {
  return path.join(frinkUserHome(), '.frink', 'plugins');
}

export function canonicalPayloadDir(p: PluginCoords): string {
  return path.join(vendorPluginsRoot(), 'vendor', p.name, p.version);
}

export function claudeProjectionDir(p: PluginCoords): string {
  return path.join(vendorPluginsRoot(), 'projections', 'claude-code', p.name, p.version);
}

export function codexProjectionDir(p: PluginCoords): string {
  return path.join(vendorPluginsRoot(), 'projections', 'codex', p.name, p.version);
}

/** Every version of one plugin across the three tiers — what removal sweeps. */
export function pluginTierDirs(name: string): [string, string, string] {
  const root = vendorPluginsRoot();
  return [
    path.join(root, 'vendor', name),
    path.join(root, 'projections', 'claude-code', name),
    path.join(root, 'projections', 'codex', name),
  ];
}

/** claude-code's catalog mirror keeps the marketplace in its path: the CLI resolves plugins through it. */
export function marketplaceCatalogDir(marketplace: string): string {
  return path.join(vendorPluginsRoot(), 'marketplaces', 'claude-code', marketplace);
}
