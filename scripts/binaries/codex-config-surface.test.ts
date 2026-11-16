import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import configSurface from '../../patches/codex/config-surface.json';
import pinnedManifest from '../../patches/codex/manifest.json';
import {
  assertPinnedConfigSurface,
  assertSourceConfigSurface,
  parseCodexConfigSurface,
  parseCodexFeatures,
} from './codex-config-surface.mjs';

const manifest = { version: pinnedManifest.version };

describe('pinned Codex config surface', () => {
  const schema = JSON.stringify({
    properties: {
      model: { type: 'string' },
      features: { properties: { shell_tool: {}, legacy_alias: {} } },
    },
  });
  const spec = (body: string) => `    FeatureSpec {\n        id: Feature::X,\n${body}\n    },`;
  const featuresSource = (...specs: string[]) =>
    `pub struct FeatureSpec {\n}\npub const FEATURES: &[FeatureSpec] = &[\n${specs.join('\n')}\n];\n`;
  const shellTool = spec(
    '        key: "shell_tool",\n        stage: Stage::Stable,\n        default_enabled: true,',
  );
  const secretAuthStorage = spec(
    '        key: "secret_auth_storage",\n        stage: Stage::Experimental {\n            name: "x",\n        },\n        default_enabled: cfg!(windows),',
  );
  const upstream = parseCodexConfigSurface(schema, featuresSource(shellTool, secretAuthStorage));
  const declared = {
    version: manifest.version,
    config: { model: 'native', features: 'frink-sets' },
    featureFlagKeys: ['legacy_alias', 'shell_tool'],
    features: {
      shell_tool: { stage: 'Stable', default: true, route: 'native' },
      secret_auth_storage: { stage: 'Experimental', default: 'cfg:windows', route: 'native' },
    },
  };

  it('reads config keys, feature flags, and each feature stage and platform default', () => {
    expect(upstream).toEqual({
      configKeys: ['features', 'model'],
      featureFlagKeys: ['legacy_alias', 'shell_tool'],
      features: {
        shell_tool: { stage: 'Stable', default: true },
        secret_auth_storage: { stage: 'Experimental', default: 'cfg:windows' },
      },
    });
  });

  it('reads a stage that depends on the platform', () => {
    const conditional = spec(
      '        key: "prevent_idle_sleep",\n        stage: if cfg!(any(\n            target_os = "macos"\n        )) {\n            Stage::Experimental { name: "x" }\n        } else {\n            Stage::UnderDevelopment\n        },\n        default_enabled: false,',
    );
    expect(parseCodexFeatures(featuresSource(conditional))).toEqual({
      prevent_idle_sleep: {
        stage: 'cfg(any( target_os = "macos" )) ? Experimental : UnderDevelopment',
        default: false,
      },
    });
  });

  it('fails closed on a FeatureSpec it cannot read, instead of skipping it', () => {
    const unreadable = spec(
      '        key: "odd",\n        stage: STAGE_FOR_ODD,\n        default_enabled: false,',
    );
    expect(() => parseCodexFeatures(featuresSource(shellTool, unreadable))).toThrow(
      'Could not read a Codex FeatureSpec',
    );
    expect(() => parseCodexFeatures(featuresSource(shellTool, shellTool))).toThrow(
      'Read 1 Codex features from 2 FeatureSpec entries',
    );
    expect(() => parseCodexFeatures('pub struct FeatureSpec {}')).toThrow('has no');
    expect(() => parseCodexConfigSurface('{}', featuresSource(shellTool))).toThrow(
      'no top-level properties object',
    );
    expect(() =>
      parseCodexConfigSurface(
        JSON.stringify({ properties: { model: {} } }),
        featuresSource(shellTool),
      ),
    ).toThrow('no features properties object');
  });

  it('reads every entry however it is spaced, and fails on one it cannot split out', () => {
    const tight =
      '    FeatureSpec{ id: Feature::Y, key: "tight", stage: Stage::Stable, default_enabled: false },';
    const sameLine = `${shellTool} FeatureSpec { id: Feature::Z, key: "inline", stage: Stage::Removed, default_enabled: true },`;
    expect(Object.keys(parseCodexFeatures(featuresSource(sameLine, tight))).sort()).toEqual([
      'inline',
      'shell_tool',
      'tight',
    ]);
    const built = '    FeatureSpec::experimental("built"),';
    expect(() => parseCodexFeatures(featuresSource(shellTool, built))).toThrow(
      'Found 2 FeatureSpec entries but split out 1',
    );
  });

  it('accepts a manifest that still matches upstream', () => {
    expect(() => assertPinnedConfigSurface(manifest, declared, upstream)).not.toThrow();
  });

  it('names the config keys and features a bump added, so each one gets routed', () => {
    const { model: _model, ...config } = declared.config;
    const { shell_tool: _shell, ...features } = declared.features;
    expect(() =>
      assertPinnedConfigSurface(manifest, { ...declared, config, features }, upstream),
    ).toThrow(/config keys added: model\n {2}features added: shell_tool/);
  });

  it('names what a bump removed, so a dead route is not kept forever', () => {
    const stale = {
      ...declared,
      config: { ...declared.config, retired: 'native' },
      featureFlagKeys: [...declared.featureFlagKeys, 'old_flag'],
      features: {
        ...declared.features,
        gone: { stage: 'Removed', default: false, route: 'native' },
      },
    };
    expect(() => assertPinnedConfigSurface(manifest, stale, upstream)).toThrow(
      /config keys removed: retired\n {2}feature flag keys removed: old_flag\n {2}features removed: gone/,
    );
  });

  it('names stage and default changes with their old and new values', () => {
    const moved = {
      ...declared,
      features: {
        ...declared.features,
        shell_tool: { stage: 'Experimental', default: false, route: 'native' },
      },
    };
    expect(() => assertPinnedConfigSurface(manifest, moved, upstream)).toThrow(
      /feature stage changed: shell_tool \(Experimental → Stable\)\n {2}feature default changed: shell_tool \(false → true\)/,
    );
  });

  it('rejects a manifest left behind on the previous pin', () => {
    expect(() =>
      assertPinnedConfigSurface(manifest, { ...declared, version: 'rust-v0.149.0' }, upstream),
    ).toThrow(`config-surface.json pins rust-v0.149.0, manifest pins ${manifest.version}`);
  });

  it('pins the same Codex version as the build manifest', () => {
    expect(configSurface.version).toBe(pinnedManifest.version);
  });

  it('reads the schema and FEATURES table from where the pinned source tree keeps them', () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-surface-'));
    const write = (relative: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(sourceDir, relative)), { recursive: true });
      fs.writeFileSync(path.join(sourceDir, relative), text);
    };
    try {
      const flags = Object.fromEntries(configSurface.featureFlagKeys.map((key) => [key, {}]));
      const keys = Object.fromEntries(
        [...Object.keys(configSurface.config), 'brand_new_key'].map((key) => [key, {}]),
      );
      const properties = { ...keys, features: { properties: flags } };
      write('codex-rs/core/config.schema.json', JSON.stringify({ properties }));
      write('codex-rs/features/src/lib.rs', featuresSource(shellTool));
      expect(() => assertSourceConfigSurface(pinnedManifest, sourceDir)).toThrow(
        /drifted from rust-v[\d.]+:\n {2}config keys added: brand_new_key\n/,
      );
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});
