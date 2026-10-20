import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_SURFACE_PATH = path.join(ROOT_DIR, 'patches', 'codex', 'config-surface.json');
const CONFIG_SCHEMA_PATH = ['codex-rs', 'core', 'config.schema.json'];
const FEATURES_SOURCE_PATH = ['codex-rs', 'features', 'src', 'lib.rs'];
const FEATURES_TABLE_START = 'pub const FEATURES: &[FeatureSpec] = &[';
const FEATURE_SPEC_SPLIT = /\bFeatureSpec\s*\{/;
const FEATURE_SPEC_MENTION = /\bFeatureSpec\b/g;
const FEATURE_KEY_PATTERN = /\bkey:\s*"([^"]+)"/;
const FEATURE_STAGE_PATTERN = /\bstage:([\s\S]*?)\bdefault_enabled:/;
const FEATURE_STAGE_NAME_PATTERN = /Stage::(\w+)/g;
const FEATURE_DEFAULT_PATTERN = /\bdefault_enabled:\s*(true|false|cfg!\()/;

/** The whitespace-collapsed condition of the first `cfg!(…)` in `text`, or null when it has none. */
function cfgCondition(text) {
  const open = text.indexOf('cfg!(');
  if (open === -1) return null;
  let depth = 0;
  for (let index = open + 4; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    if (text[index] === ')') depth -= 1;
    if (depth === 0)
      return text
        .slice(open + 5, index)
        .replace(/\s+/g, ' ')
        .trim();
  }
  return null;
}

/** A FeatureSpec's stage; a platform-dependent one reads "cfg(<condition>) ? A : B". */
function featureStage(block) {
  const expression = FEATURE_STAGE_PATTERN.exec(block)?.[1] ?? '';
  const names = [...expression.matchAll(FEATURE_STAGE_NAME_PATTERN)].map((match) => match[1]);
  const condition = cfgCondition(expression);
  if (condition === null) return names.length === 1 ? names[0] : null;
  return names.length === 2 ? `cfg(${condition}) ? ${names[0]} : ${names[1]}` : null;
}

/** A FeatureSpec's default; a platform-dependent one reads "cfg:<condition>". */
function featureDefault(block) {
  const value = FEATURE_DEFAULT_PATTERN.exec(block)?.[1];
  if (value !== 'cfg!(') return value === undefined ? null : value === 'true';
  const condition = cfgCondition(block.slice(block.indexOf('default_enabled:')));
  return condition === null ? null : `cfg:${condition}`;
}

/** Each FEATURES entry's stage and default. Anything it cannot read fails rather than skips. */
export function parseCodexFeatures(featuresSource) {
  const start = featuresSource.indexOf(FEATURES_TABLE_START);
  if (start === -1) throw new Error(`Codex features source has no "${FEATURES_TABLE_START}"`);
  const table = featuresSource.slice(start, featuresSource.indexOf('\n];', start));
  const blocks = table.split(FEATURE_SPEC_SPLIT).slice(1);
  // The table header names FeatureSpec once; every other mention must be an entry we split out.
  const mentions = (table.match(FEATURE_SPEC_MENTION) ?? []).length - 1;
  if (mentions !== blocks.length) {
    throw new Error(`Found ${mentions} FeatureSpec entries but split out ${blocks.length}`);
  }
  const features = {};
  for (const block of blocks) {
    const key = FEATURE_KEY_PATTERN.exec(block)?.[1];
    const stage = featureStage(block);
    const defaultValue = featureDefault(block);
    if (!key || stage === null || defaultValue === null) {
      throw new Error(`Could not read a Codex FeatureSpec: ${block.trim().slice(0, 120)}`);
    }
    features[key] = { stage, default: defaultValue };
  }
  if (Object.keys(features).length !== blocks.length) {
    throw new Error(
      `Read ${Object.keys(features).length} Codex features from ${blocks.length} FeatureSpec entries`,
    );
  }
  return features;
}

/** The keys of a JSON schema node's `properties`; a schema without them is unreadable. */
function propertyKeys(node, label) {
  const properties = node?.properties;
  // JSON.parse builds plain objects only, so this rejects null, primitives and arrays alike.
  if (properties?.constructor !== Object) {
    throw new Error(`Codex config schema has no ${label} properties object`);
  }
  return Object.keys(properties).sort();
}

/** The config keys and feature flags a pinned Codex source accepts. */
export function parseCodexConfigSurface(schemaSource, featuresSource) {
  const schema = JSON.parse(schemaSource);
  return {
    configKeys: propertyKeys(schema, 'top-level'),
    featureFlagKeys: propertyKeys(schema.properties.features, 'features'),
    features: parseCodexFeatures(featuresSource),
  };
}

const keysOnlyIn = (from, other) => from.filter((key) => !other.includes(key));

/**
 * A Codex config key or feature Frink never routed may do nothing inside Frink, or run an
 * execution surface Frink's host permission does not cover, so a bump that changes either must
 * classify each change before it can produce a binary.
 */
export function assertPinnedConfigSurface(manifest, declared, upstream) {
  if (declared.version !== manifest.version) {
    throw new Error(
      `config-surface.json pins ${declared.version}, manifest pins ${manifest.version}`,
    );
  }
  const declaredConfig = Object.keys(declared.config);
  const declaredFeatures = Object.keys(declared.features);
  const upstreamFeatures = Object.keys(upstream.features);
  const changed = (field) =>
    upstreamFeatures
      .filter(
        (key) =>
          declared.features[key] && declared.features[key][field] !== upstream.features[key][field],
      )
      .map((key) => `${key} (${declared.features[key][field]} → ${upstream.features[key][field]})`);
  const drift = [
    ['config keys added', keysOnlyIn(upstream.configKeys, declaredConfig)],
    ['config keys removed', keysOnlyIn(declaredConfig, upstream.configKeys)],
    ['feature flag keys added', keysOnlyIn(upstream.featureFlagKeys, declared.featureFlagKeys)],
    ['feature flag keys removed', keysOnlyIn(declared.featureFlagKeys, upstream.featureFlagKeys)],
    ['features added', keysOnlyIn(upstreamFeatures, declaredFeatures)],
    ['features removed', keysOnlyIn(declaredFeatures, upstreamFeatures)],
    ['feature stage changed', changed('stage')],
    ['feature default changed', changed('default')],
  ].filter(([, keys]) => keys.length > 0);
  if (drift.length === 0) return;
  throw new Error(
    `Codex config surface drifted from ${declared.version}:\n${drift
      .map(([label, keys]) => `  ${label}: ${keys.join(', ')}`)
      .join('\n')}\nRoute each in patches/codex/config-surface.json.`,
  );
}

/** Checks a prepared, pinned Codex source tree against the committed config surface. */
export function assertSourceConfigSurface(manifest, sourceDir) {
  assertPinnedConfigSurface(
    manifest,
    JSON.parse(fs.readFileSync(CONFIG_SURFACE_PATH, 'utf8')),
    parseCodexConfigSurface(
      fs.readFileSync(path.join(sourceDir, ...CONFIG_SCHEMA_PATH), 'utf8'),
      fs.readFileSync(path.join(sourceDir, ...FEATURES_SOURCE_PATH), 'utf8'),
    ),
  );
}
