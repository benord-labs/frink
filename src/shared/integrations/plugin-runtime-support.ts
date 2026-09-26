/**
 * Per-runtime delivery honesty for builtin plugins: never claim what a runtime cannot load.
 * Each row separates skills, commands, MCP, Flow triggers and Flow actions.
 */
import { LAUNCH_FLAGS } from '../launch-flags';
import { DELIVERABLE_AUTH_KINDS } from './catalog/manifest-schema';
import type { PluginMcpServer, PluginPackageContents } from './plugins';

/**
 * Runtimes a plugin can reach today, not every chat runtime Frink offers.
 */
export type PluginRuntime = 'claude-code' | 'codex';

/** What one runtime actually loads from the package — the facts the page draws as a grid. */
export interface PluginRuntimeDelivery {
  skills: boolean;
  commands: boolean;
  mcp: boolean;
  /** Inbound events that can start a Flow, independently of chat-runtime delivery. */
  flowTriggers: boolean;
  /** Outbound nodes a Flow can execute, independently of chat-runtime delivery. */
  flowActions: boolean;
}

interface PluginRuntimeSupport {
  status: 'supported' | 'native_only' | 'unsupported';
  delivers: PluginRuntimeDelivery;
  /** Why an `unsupported` runtime gets nothing; a delivering runtime carries no prose. */
  reason?: string;
}

export type PluginRuntimeSupportMatrix = Readonly<Record<PluginRuntime, PluginRuntimeSupport>>;

/** Verified package contents, supplied by runtime inspection or the generated catalogue. */
export type StagedDeliveryInventory = {
  skills: ReadonlyArray<unknown>;
  commands: ReadonlyArray<unknown>;
};

/** Narrow marker-derived delivery to the verified package skill and command inventory. */
export function withStagedDelivery(
  matrix: PluginRuntimeSupportMatrix,
  inventory: StagedDeliveryInventory,
) {
  const skills = inventory.skills.length > 0;
  const commands = inventory.commands.length > 0;
  const claude = matrix['claude-code'];
  const codex = matrix.codex;
  return {
    'claude-code':
      claude.status === 'unsupported'
        ? claude
        : { ...claude, delivers: { ...claude.delivers, skills, commands } },
    // Frink delivers portable skills through extra roots and expands commands before send.
    codex:
      codex.status === 'unsupported'
        ? codex
        : {
            ...codex,
            delivers: { ...codex.delivers, skills, commands },
          },
  } satisfies PluginRuntimeSupportMatrix;
}

/** Flow capabilities come from their own catalogue lists, even without chat-runtime delivery. */
function withFlows(
  support: PluginRuntimeSupport,
  contents: PluginPackageContents,
): PluginRuntimeSupport {
  return {
    ...support,
    delivers: {
      ...support.delivers,
      flowTriggers: contents.triggers.length > 0,
      flowActions: contents.actions.length > 0,
    },
  };
}

export function builtinRuntimeSupport(
  contents: PluginPackageContents,
  vendorPluginsEnabled: boolean = LAUNCH_FLAGS.vendorClaudePlugins,
) {
  return {
    'claude-code': withFlows(claudeCodeSupport(contents, vendorPluginsEnabled), contents),
    codex: withFlows(codexSupport(contents, vendorPluginsEnabled), contents),
  } satisfies PluginRuntimeSupportMatrix;
}

const NOT_VERIFIED_REASON = "Chat tools are listed but can't be connected yet.";
const FLAG_GATED_REASON =
  'Vendor plugin delivery is flag-gated until unattended write protection lands.';

const NOTHING: PluginRuntimeDelivery = {
  skills: false,
  commands: false,
  mcp: false,
  flowTriggers: false,
  flowActions: false,
};

function unsupported(reason: string): PluginRuntimeSupport {
  return { status: 'unsupported', delivers: NOTHING, reason };
}

/** A staged vendor package (any runtime marker) delivers its http server today; catalog kinds join via DELIVERABLE_AUTH_KINDS. */
function hasVendorPackage(contents: PluginPackageContents): boolean {
  return contents.nativeExtensions.some((extension) => extension.kind === 'runtime_native');
}

/** Only an http connector reaches a runtime; a catalog-listed command server is a Coming soon row. */
function isDeliverable(server: PluginMcpServer, vendorPackage: boolean): boolean {
  return (
    server.transport.type === 'http' &&
    (vendorPackage || DELIVERABLE_AUTH_KINDS.has(server.transport.auth.kind))
  );
}

function frinkDeliveredHttp(contents: PluginPackageContents): boolean {
  const vendorPackage = hasVendorPackage(contents);
  return contents.mcpServers.some(
    (server) => server.transport.type === 'http' && isDeliverable(server, vendorPackage),
  );
}

/** Declares MCP servers but none the runtime can reach yet: a Coming soon catalog row. */
function listedOnly(contents: PluginPackageContents): boolean {
  const vendorPackage = hasVendorPackage(contents);
  return (
    contents.mcpServers.length > 0 &&
    !contents.mcpServers.some((server) => isDeliverable(server, vendorPackage))
  );
}

/**
 * Portable package skills reach Codex through Frink's extra-roots delivery. The vendor's
 * native wrapper is provenance, not a prerequisite for delivering the package contents.
 */
function codexSupport(
  contents: PluginPackageContents,
  vendorPluginsEnabled: boolean,
): PluginRuntimeSupport {
  const vendor = hasVendorPackage(contents);
  if (!vendor && listedOnly(contents)) return unsupported(NOT_VERIFIED_REASON);
  if (!vendor && !frinkDeliveredHttp(contents)) {
    return unsupported('This builtin currently has no agent capability package.');
  }
  if (!vendorPluginsEnabled) return unsupported(FLAG_GATED_REASON);
  return {
    status: 'supported',
    delivers: {
      skills: vendor,
      commands: hasVendorPackage(contents),
      mcp: frinkDeliveredHttp(contents),
      flowTriggers: false,
      flowActions: false,
    },
  };
}

function claudeCodeSupport(
  contents: PluginPackageContents,
  vendorPluginsEnabled: boolean,
): PluginRuntimeSupport {
  if (hasVendorPackage(contents) && !vendorPluginsEnabled) return unsupported(FLAG_GATED_REASON);
  const hasSkills = contents.skills.length > 0;
  const hasOtherContents =
    hasSkills ||
    contents.nativeExtensions.some(
      (extension) => extension.kind === 'runtime_native' && extension.runtime === 'claude-code',
    );
  if (frinkDeliveredHttp(contents)) {
    if (!vendorPluginsEnabled) return unsupported(FLAG_GATED_REASON);
    // A vendor package loads through claude-code's native plugin machinery: skills and commands ride along.
    const vendor = hasVendorPackage(contents);
    return {
      status: 'supported',
      delivers: {
        skills: vendor,
        commands: vendor,
        mcp: true,
        flowTriggers: false,
        flowActions: false,
      },
    };
  }
  if (listedOnly(contents) && !hasOtherContents) return unsupported(NOT_VERIFIED_REASON);
  if (hasOtherContents) {
    // Skills and a claude-code native extension still reach the session; no MCP does.
    return {
      status: 'native_only',
      delivers: {
        skills: hasSkills,
        commands: false,
        mcp: false,
        flowTriggers: false,
        flowActions: false,
      },
    };
  }
  return unsupported('This builtin currently has no agent capability package.');
}
