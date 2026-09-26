/** Pinned vendor packages for builtin catalog entries: contents attach to the builtin, with no
 * separate id. The pinned commit is the whole package, so every runtime projection derives from it. */
import type {
  PluginNativeExtension,
  PluginPackageContents,
  PluginRuntime,
  PluginSourceRef,
} from './plugins';

export type VendorPluginPin = {
  marketplace: string;
  name: string;
  version: string;
  gitCommitSha: string;
  /** The marketplace `claude plugin marketplace add` resolves; not where the payload's commits live. */
  sourceRepo: string;
  /** The repo `gitCommitSha` belongs to; the only coordinates a source link can be built from. */
  payloadRepo: string;
  /** Package directory within the payload repository, when it is not the root. */
  payloadPath?: string;
  /** Acquire the complete repository package when no marketplace entry represents it. */
  acquisition?: 'repository';
};

export const VENDOR_PLUGIN_PINS = {
  supabase: {
    marketplace: 'supabase-plugin',
    name: 'supabase',
    version: '0.1.15',
    gitCommitSha: 'f3f332e0164c34a8392772811737fda0cb972d06',
    sourceRepo: 'supabase-community/supabase-plugin',
    payloadRepo: 'supabase-community/supabase-plugin',
    acquisition: 'repository',
  },
  vercel: {
    marketplace: 'vercel',
    name: 'vercel',
    version: '0.49.0',
    gitCommitSha: 'dca8da784e876cbb8e81bd98cb5b2b87323449ca',
    sourceRepo: 'vercel/vercel-plugin',
    payloadRepo: 'vercel/vercel-plugin',
    acquisition: 'repository',
  },
  huggingface: {
    marketplace: 'huggingface-skills',
    name: 'huggingface-skills',
    version: '1.0.27',
    gitCommitSha: '97862b0fcc89c850fdd00c82ede1e62d3c930a6d',
    sourceRepo: 'huggingface/skills',
    payloadRepo: 'huggingface/skills',
    acquisition: 'repository',
  },
  notion: {
    marketplace: 'claude-plugins-official',
    name: 'notion',
    version: '0.1.0',
    gitCommitSha: '9847f2aa1a15f25df35ed1fb7b4557dbb60cd651',
    sourceRepo: 'anthropics/claude-plugins-official',
    payloadRepo: 'makenotion/claude-code-notion-plugin',
  },
  neon: {
    marketplace: 'claude-plugins-official',
    name: 'neon',
    version: '1.2.0',
    gitCommitSha: '2e0da3a1653bcdd227565ac14bb3e9e453a8b854',
    sourceRepo: 'anthropics/claude-plugins-official',
    payloadRepo: 'neondatabase/agent-skills',
    payloadPath: 'plugins/neon-postgres',
  },
  sentry: {
    marketplace: 'claude-plugins-official',
    name: 'sentry',
    version: '1.4.0',
    gitCommitSha: '73e53541d7af21672e27428c7067f4264b8a3d65',
    sourceRepo: 'anthropics/claude-plugins-official',
    payloadRepo: 'getsentry/plugin-claude',
  },
  posthog: {
    marketplace: 'claude-plugins-official',
    name: 'posthog',
    version: '1.1.62',
    gitCommitSha: '19e4737aa8ab3db315e43f35f796976a1ac37787',
    sourceRepo: 'anthropics/claude-plugins-official',
    payloadRepo: 'PostHog/ai-plugin',
  },
  canva: {
    marketplace: 'canva-skills',
    name: 'canva',
    version: '1.0.0',
    gitCommitSha: 'b56291ea0a36d0a941e1478b47959be5f1771dee',
    sourceRepo: 'canva-sdks/canva-skills',
    payloadRepo: 'canva-sdks/canva-skills',
    payloadPath: 'plugins/canva',
  },

  clickup: {
    marketplace: 'clickup-plugin-marketplace',
    name: 'clickup',
    version: '1.1.0',
    gitCommitSha: '5c5a8337d7c8ccf498c4643028d03f16fc7df9c6',
    sourceRepo: 'clickup/clickup-plugin',
    payloadRepo: 'clickup/clickup-plugin',
  },
} satisfies Record<string, VendorPluginPin>;

export function vendorPluginPin(pluginId: string): VendorPluginPin | undefined {
  return Object.entries(VENDOR_PLUGIN_PINS).find(([id]) => id === pluginId)?.[1];
}

/** Source links identify the acquired package at its verified revision. */
export function vendorPluginSource(pluginId: string): PluginSourceRef | undefined {
  const pin = vendorPluginPin(pluginId);
  if (!pin) return undefined;
  const source: PluginSourceRef = { repo: pin.payloadRepo, commit: pin.gitCommitSha };
  if (pin.payloadPath) source.path = pin.payloadPath;
  return source;
}

/** The pin owning a package NAME — the on-disk store is keyed by name (sc-2805), so names are unique. */
export function vendorPluginPinByName(name: string): VendorPluginPin | undefined {
  return Object.values(VENDOR_PLUGIN_PINS).find((pin) => pin.name === name);
}

function nativePackageContents(pluginId: string, runtimes: readonly PluginRuntime[]) {
  return {
    mcpServers: [],
    nativeExtensions: runtimes.map((runtime): PluginNativeExtension => ({
      id: `${pluginId}.${runtime === 'codex' ? 'codex' : 'claude'}-plugin`,
      kind: 'runtime_native',
      runtime,
      path: `.${runtime === 'codex' ? 'codex' : 'claude'}-plugin/plugin.json`,
    })),
  };
}

/** Capability declarations mirror the pinned vendor packages; installation acquires the full payload. */
interface VendorPluginContents {
  readonly [pluginId: string]: Pick<PluginPackageContents, 'mcpServers' | 'nativeExtensions'>;
}
export const VENDOR_PLUGIN_CONTENTS: VendorPluginContents = {
  supabase: nativePackageContents('supabase', ['claude-code']),
  vercel: nativePackageContents('vercel', ['claude-code']),
  huggingface: nativePackageContents('huggingface', ['claude-code']),
  notion: nativePackageContents('notion', ['claude-code']),
  neon: nativePackageContents('neon', ['claude-code']),
  sentry: nativePackageContents('sentry', ['claude-code']),
  posthog: nativePackageContents('posthog', ['claude-code', 'codex']),
  canva: nativePackageContents('canva', ['claude-code', 'codex']),
  clickup: nativePackageContents('clickup', ['claude-code']),
};
