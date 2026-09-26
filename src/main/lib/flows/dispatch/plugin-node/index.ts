/** Plugin-node dispatcher, catalog-first: a saved node resolves its action even once its plugin is gone,
 * and the preflight refuses in plain words before any network call. */
import {
  type JsonObject,
  wrapMcpPresetArgs,
} from '../../../../../shared/lib/flows/mcp-tool-preset';
import { isInstallablePluginId } from '../../../../../shared/integrations/installable-plugins';
import { z } from 'zod';
import { findPluginActionByNodeName } from '../../../../../shared/integrations/plugin-nodes';
import { getPluginDefinition, type PluginAction } from '../../../../../shared/integrations/plugins';
import {
  findMissingRequiredCustomNodeInputs,
  type JsonValue,
  type ManifestInputDeclarations,
  parseManifestInputDeclarations,
} from '../../../../../shared/lib/flows/custom-node-required-inputs';
import { coerceCustomNodeInputValue, readDeclaredInputType } from '../../../custom-nodes/runtime';
import { getDatabase } from '../../../db';
import { getByPluginId as getPluginInstallation } from '../../../db/repos/plugin-installations';
import { listLocalIntegrations } from '../../../db/repos/webhook-ingress';
import { listPluginNodeSchemas } from '../../../db/repos/plugin-node-schemas';
import { withPluginLifecycleOperation } from '../../../integrations/connection-lifecycle-operation';
import {
  type PluginNodeFields,
  pluginNodeFields,
} from '../../../integrations/plugin-node-derivation';
import { resolvePluginServerTarget } from '../../../integrations/plugin-node-derivation/server-target';
import type { McpToolCallValue } from '../../../mcp/tools-probe/call';
import { callServerTool } from '../../../mcp/tools-probe/resolve';
import { captureMainMessage } from '../../../sentry/init';
import { buildVariables } from '../../block-context';
import {
  JSON_VALUE,
  renderTemplate,
  renderTemplateDeep,
  renderTemplateForJson,
} from '../../template-utils';
import type { Dispatcher } from '../types';

/** An http row rides the plugin's own credential (checked when the server resolves); a stdio row needs one live account — the config pin, else the only one. */
async function resolveConnectionId(
  pluginId: string,
  pinned: unknown,
): Promise<{ ok: true; integrationId?: string } | { ok: false; message: string }> {
  const servers = getPluginDefinition(pluginId)?.contents.mcpServers ?? [];
  if (servers.some((server) => server.transport.type === 'http')) return { ok: true };
  if (typeof pinned === 'string' && pinned.length > 0) return { ok: true, integrationId: pinned };
  const rows = (await listLocalIntegrations(getDatabase())).filter(
    (row) => row.provider === pluginId && row.isActive,
  );
  if (rows.length === 1) return { ok: true, integrationId: rows[0].id };
  if (rows.length === 0) {
    return {
      ok: false,
      message: `${pluginId} is not connected — connect an account in Settings → Plugins.`,
    };
  }
  return {
    ok: false,
    message: `Multiple ${pluginId} accounts are connected — pick one in this node's settings.`,
  };
}

function failed(message: string, retryable: boolean, startedAt: number): DispatchOutcome {
  return {
    type: 'completed',
    output: {
      status: 'failed',
      outputs: {},
      artifacts: [],
      durationMs: Date.now() - startedAt,
      error: { message, retryable },
    },
  };
}

function completed(outputs: Record<string, unknown>, startedAt: number): DispatchOutcome {
  return {
    type: 'completed',
    output: { status: 'completed', outputs, artifacts: [], durationMs: Date.now() - startedAt },
  };
}

type DispatchOutcome = Awaited<ReturnType<Dispatcher>>;

/** Config values with templates rendered; the connection pin is routing, not input. */
function templatedConfig(
  config: Record<string, unknown>,
  variables: ReturnType<typeof buildVariables>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === 'connectionId') continue;
    out[key] = typeof value === 'string' ? renderTemplate(value, variables) : value;
  }
  return out;
}

/** A plugin with an installation row refuses on a missing or removed row and on a turned-off one,
 * each in its own words (frink-integration-plugin 2026-08-16); an api_token provider has no row and is never gated. */
async function executionRefusal(pluginId: string): Promise<string | null> {
  if (!isInstallablePluginId(pluginId)) return null;
  const installation = await getPluginInstallation(getDatabase(), pluginId);
  if (!installation?.isInstalled) {
    return `${pluginId} is not installed — add it in Settings → Plugins.`;
  }
  return installation.isEnabled
    ? null
    : `${pluginId} is turned off — turn it on in Settings → Plugins.`;
}

/** The generic call-tool node's preflighted args: `tool` is required by its manifest, `arguments` parsed by the json path. */
const CALL_TOOL_ARGS = z.object({
  tool: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

type PluginDispatchInput = {
  nodeName: string;
  pluginId: string;
  integrationId?: string;
  args: Record<string, unknown>;
  startedAt: number;
};

/** Resolve and call under the plugin's lifecycle mutex: a Turn off, Disconnect or Remove waits for the call, never races it. */
async function runMcpToolNode(
  source: { serverId: string; toolId: string },
  { nodeName, pluginId, integrationId, args, startedAt }: PluginDispatchInput,
): Promise<DispatchOutcome> {
  const outcome = await withPluginLifecycleOperation(pluginId, async () => {
    const resolved = await resolvePluginServerTarget(pluginId, source.serverId);
    if (!resolved.ok) return resolved;
    const { config, credentials, serverName } = resolved.target;
    return {
      ok: true as const,
      result: await callServerTool(config, credentials, source.toolId, args, serverName),
    };
  });
  if (!outcome.ok) return { type: 'error', message: `${nodeName}: ${outcome.reason}` };
  const { result } = outcome;
  if (!result.ok) {
    // Transport failures are already captured at the MCP classifier; a spawn
    // failure here means the provisioned server binary is gone — infra, not
    // user input.
    if (result.reason === 'spawn_failed') {
      captureMainMessage(`Plugin node MCP spawn failed: ${result.message}`, 'warning', {
        surface: 'plugin-node-dispatch',
        pluginId,
      });
    }
    return failed(`${nodeName}: ${result.message}`, result.reason !== 'spawn_failed', startedAt);
  }
  return projectToolResult(nodeName, result.result, startedAt);
}

const TOOL_RESULT = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  structuredContent: z.record(z.string(), z.json()).optional(),
});

/**
 * A tool-level error (the server answered, the tool refused) fails the step with the tool's own
 * words; a success hands the next step the joined text as `text`, the whole envelope as `result`.
 */
function projectToolResult(
  nodeName: string,
  value: McpToolCallValue,
  startedAt: number,
): DispatchOutcome {
  const envelope = TOOL_RESULT.safeParse(value);
  const blocks = envelope.success ? (envelope.data.content ?? []) : [];
  const text = blocks.flatMap((block) => (block.text === undefined ? [] : [block.text])).join('\n');
  if (envelope.success && envelope.data.isError) {
    return failed(`${nodeName}: ${text || 'the tool reported an error'}`, false, startedAt);
  }
  const outputs = { text, result: value };
  const structured = envelope.success ? envelope.data.structuredContent : undefined;
  return completed(structured === undefined ? outputs : { ...outputs, structured }, startedAt);
}

type DispatchArgs = PluginDispatchInput['args'];
type TemplateVariables = Parameters<typeof templatedConfig>[1];
type Preflight = { ok: true; args: DispatchArgs } | { ok: false; message: string };
type CoercedArgs =
  | { ok: true; args: DispatchArgs; unknown: string[] }
  | { ok: false; message: string };

function quote(keys: string[]): string {
  return keys.map((key) => `"${key}"`).join(', ');
}

type CoercedArg = ReturnType<typeof coerceCustomNodeInputValue>;

/** A `json` input is text whose templates render JSON-aware before parsing; blank means omit. */
function parseJsonArgument(raw: DispatchArgs[string], variables: TemplateVariables): CoercedArg {
  const text = z.string().safeParse(raw);
  // Authored as a structure already (manual-mode fields, or frink_flows_patch writing config JSON).
  if (!text.success) {
    const structure = JSON_VALUE.safeParse(raw);
    return {
      kind: 'value',
      value: structure.success ? renderTemplateDeep(structure.data, variables) : raw,
    };
  }
  if (text.data.trim() === '') return { kind: 'missing' };
  try {
    return { kind: 'value', value: JSON.parse(renderTemplateForJson(text.data, variables)) };
  } catch {
    return { kind: 'error', error: 'not valid JSON.' };
  }
}

/** One declared input: raw JSON text renders JSON-aware and parses; anything else coerces from its rendered text. */
function coerceDeclared(
  declaration: ManifestInputDeclarations[string],
  raw: DispatchArgs[string],
  rendered: DispatchArgs[string],
  variables: TemplateVariables,
): CoercedArg {
  if (declaration.type === 'json') return parseJsonArgument(raw, variables);
  return coerceCustomNodeInputValue(readDeclaredInputType(declaration), rendered);
}

/**
 * Render and coerce each configured key to its projected type. A snapshot-known field the flat form
 * cannot render passes through untyped (the provider validates it); a rendered-empty scalar is omitted.
 */
function coerceArgs(
  nodeName: string,
  fields: PluginNodeFields,
  declarations: ManifestInputDeclarations,
  config: DispatchArgs,
  variables: TemplateVariables,
): CoercedArgs {
  const rendered = templatedConfig(config, variables);
  const out: DispatchArgs = {};
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(rendered)) {
    if (fields.unsupportedFields.includes(key)) {
      out[key] = value;
      continue;
    }
    const declaration = declarations[key];
    if (!declaration) {
      unknown.push(key);
      continue;
    }
    const coerced = coerceDeclared(declaration, config[key], value, variables);
    if (coerced.kind === 'error') {
      return { ok: false, message: `${nodeName} input "${key}": ${coerced.error}` };
    }
    if (coerced.kind === 'value') out[key] = coerced.value;
  }
  return { ok: true, args: out, unknown };
}

/**
 * Preflight templated args against the cached schema before any network call; a key in neither
 * `inputs` nor `unsupportedFields` fails closed (integration-node-field-source 2026-08-16).
 */
function preflightMcpArgs(
  nodeName: string,
  pluginId: string,
  action: PluginAction,
  config: DispatchArgs,
  variables: TemplateVariables,
): Preflight {
  const fields = pluginNodeFields(action, listPluginNodeSchemas(getDatabase(), pluginId));
  if (!fields) {
    return {
      ok: false,
      message: `${nodeName}: Frink has not loaded this tool's fields yet — turn ${pluginId} off and on in Settings → Plugins, then run again.`,
    };
  }
  // SAFETY: the cache row or the catalog's own literals; the parser reads every field before it is trusted.
  const declarations = parseManifestInputDeclarations(fields.inputs as JsonValue);
  const coerced = coerceArgs(nodeName, fields, declarations, config, variables);
  if (!coerced.ok) return coerced;
  if (coerced.unknown.length > 0) {
    const plural = coerced.unknown.length > 1;
    return {
      ok: false,
      message: `${nodeName}: ${quote(coerced.unknown)} ${plural ? 'are not fields' : 'is not a field'} of this node's current schema — remove ${plural ? 'them' : 'it'} from the node, or turn ${pluginId} off and on to refresh its fields.`,
    };
  }
  // The editor's own predicate, so a required field with a schema default (shown, never saved) is
  // satisfied here exactly as it is there. SAFETY: args are node config JSON or scalars coerced from it.
  const missing = findMissingRequiredCustomNodeInputs(
    declarations,
    coerced.args as Record<string, JsonValue>,
  );
  if (missing.length > 0) {
    return {
      ok: false,
      message: `${nodeName} is missing required ${missing.length > 1 ? 'inputs' : 'input'}: ${quote(missing)}`,
    };
  }
  return { ok: true, args: coerced.args };
}

export const dispatchPluginNode: Dispatcher = async (ctx) => {
  const startedAt = Date.now();
  const nodeName = ctx.node.blockType;
  const found = findPluginActionByNodeName(nodeName);
  if (!found) return { type: 'error', message: `Unknown block type: ${nodeName}` };
  const { pluginId, action } = found;

  if (action.source.type !== 'provider_mcp') {
    return { type: 'error', message: `Unsupported plugin action: ${nodeName}` };
  }

  const config = (ctx.node.config ?? {}) as Record<string, unknown>;
  const connection = await resolveConnectionId(pluginId, config.connectionId);
  if (!connection.ok) return { type: 'error', message: `${nodeName}: ${connection.message}` };
  // Disable prevents actions (integration-connector-lifecycle): after the connect check so a
  // removed or unconnected plugin keeps its accurate message.
  const refusal = await executionRefusal(pluginId);
  if (refusal) return { type: 'error', message: `${nodeName}: ${refusal}` };
  const variables = buildVariables({
    triggerContext: ctx.triggerContext,
    previousOutput: ctx.previousOutput,
    loopContext: ctx.loopContext,
  });
  const input: Omit<PluginDispatchInput, 'args'> = {
    nodeName,
    pluginId,
    integrationId: connection.integrationId,
    startedAt,
  };
  const preflight = preflightMcpArgs(nodeName, pluginId, action, config, variables);
  if (!preflight.ok) return { type: 'error', message: preflight.message };
  const { serverId, toolId } = action.source;
  if (toolId !== undefined) {
    return runMcpToolNode(
      { serverId, toolId },
      {
        ...input,
        args: action.source.preset
          ? // SAFETY: dispatch args are JSON already; they leave as MCP JSON-RPC parameters.
            wrapMcpPresetArgs(action.source.preset, preflight.args as JsonObject)
          : preflight.args,
      },
    );
  }
  const call = CALL_TOOL_ARGS.safeParse(preflight.args);
  if (!call.success) {
    return failed(`${nodeName}: "arguments" must be a JSON object.`, false, startedAt);
  }
  return runMcpToolNode(
    { serverId, toolId: call.data.tool },
    { ...input, args: call.data.arguments ?? {} },
  );
};
