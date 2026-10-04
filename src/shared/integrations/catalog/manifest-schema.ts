/** Per-plugin catalog manifest — portable part + `frink` overlay, `.strict()` throughout (frink-integration-plugin 2026-09-01 Target). */
import { z } from 'zod';
import { mcpToolPresetSchema } from '../../lib/flows/mcp-tool-preset';
import { CUSTOM_NODE_ICON_KEY_LIST } from '../../lib/custom-node-icon-allowlist';

const slug = z.string().regex(/^[a-z][a-z0-9-]*$/, 'lowercase kebab-case');
const httpsUrl = z.url({ protocol: /^https$/ });

const pluginMcpAuthSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('static_client'),
      clientId: z.string().min(1),
      callbackPort: z.number().int().min(1).max(65535),
      scope: z.string().min(1).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('frink_client'), scope: z.string().min(1).optional() }).strict(),
  z
    .object({
      kind: z.literal('user_token'),
      setupUrl: httpsUrl,
      validation: z.object({ url: httpsUrl }).strict(),
    })
    .strict(),
  z.object({ kind: z.literal('pending') }).strict(),
]);

/** How Frink authenticates a delivered http server; `pending` only on a Coming soon row (sc-1837 Never-rule, narrowed 2026-09-01). */
export type PluginMcpAuth = z.infer<typeof pluginMcpAuthSchema>;

/** Catalog auth kinds the consent path can complete — the one gate for `available` and the runtime matrix; user_token joins with the token grant. */
export const DELIVERABLE_AUTH_KINDS: ReadonlySet<PluginMcpAuth['kind']> = new Set<
  PluginMcpAuth['kind']
>(['static_client', 'frink_client', 'user_token']);

const httpServerSchema = z
  .object({ type: z.literal('http'), url: httpsUrl, auth: pluginMcpAuthSchema })
  .strict();
const stdioServerSchema = z
  .object({ command: z.string().min(1), args: z.array(z.string()).optional() })
  .strict();

const sourceSchema = z
  .object({
    repo: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{7,40}$/),
    path: z.string().min(1),
    license: z.literal('MIT'),
    /** Vendor destination for users; repo/commit/path retain the acquired package's attribution. */
    official: z
      .object({ url: httpsUrl, kind: z.enum(['plugin', 'documentation']) })
      .strict()
      .optional(),
  })
  .strict();

/** Where a package's contents come from, at the pinned revision; a vendor pin knows only repo + commit. */
export type PluginSourceRef = Pick<z.infer<typeof sourceSchema>, 'repo' | 'commit'> &
  Partial<Pick<z.infer<typeof sourceSchema>, 'path' | 'license' | 'official'>>;

/** A curated Flow node over one of the manifest's http servers: `id` is `<plugin>.<action>`, `tool` the vendor's tools/list id (frink-integration-plugin 2026-09-04). */
const actionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9_]*$/, '<plugin>.<action>'),
    label: z.string().min(1),
    description: z.string().min(1),
    icon: z.enum(CUSTOM_NODE_ICON_KEY_LIST).optional(),
    server: slug,
    tool: z.string().min(1),
    preset: mcpToolPresetSchema.optional(),
  })
  .strict();

/** RFC 7230 token: any tchar, so `X_Foo_Bar` and `x-posthog-mcp-mode` are both legal. */
const headerName = z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'HTTP header name');

/** How Frink learns which vendor user signed in: one read-only tool call and a dot path to the id.
 * That id is what an event's assignee is compared against, so a trigger can watch "assigned to me". */
const identitySchema = z
  .object({
    server: slug,
    tool: z.string().min(1),
    /** For a server that names the signed-in user only through a lookup that takes input. */
    args: z.record(z.string(), z.json()).optional(),
    /** A numeric segment indexes a list. */
    idPath: z.string().min(1),
  })
  .strict();

export type PluginIdentityLookup = z.infer<typeof identitySchema>;

const baseManifestSchema = z
  .object({
    name: slug,
    displayName: z.string().min(1).optional(),
    /** The directory row's subtitle — one line, never prose (plugins.test.ts caps it at 48). */
    description: z.string().min(1).max(48).optional(),
    longDescription: z.string().min(1).optional(),
    mcpServers: z.record(slug, z.union([httpServerSchema, stdioServerSchema])),
    frink: z
      .object({
        keywords: z.array(z.string().min(1)).optional(),
        /** 1-3 plain sentences a first-timer must satisfy at the vendor — a role, a plan, an admin toggle — before Connect can succeed. */
        beforeYouConnect: z.array(z.string().min(1).max(200)).min(1).max(3).optional(),
        source: sourceSchema.optional(),
        /** Request headers per server that ride ONLY Flow-side probes and calls, never chat delivery. */
        flowHeaders: z.record(slug, z.record(headerName, z.string().min(1))).optional(),
        identity: identitySchema.optional(),
        actions: z.array(actionSchema).optional(),
        /** Held back from Connect until its end-to-end test passes, whatever its auth could deliver. */
        status: z.literal('coming_soon').optional(),
      })
      .strict(),
  })
  .strict();

/** Action suffix reserved for the generic call-tool row the catalog appends to every http plugin. */
export const CALL_TOOL_ACTION = 'call_tool';

export function httpServerKeys(manifest: z.infer<typeof baseManifestSchema>): Set<string> {
  return new Set(
    Object.entries(manifest.mcpServers)
      .filter(([, server]) => 'url' in server)
      .map(([key]) => key),
  );
}

/** Builds the manifest schema against a set of deliverable auth kinds. The parameter is vestigial:
 * `pluginManifestSchema` below is the only call site and always passes `DELIVERABLE_AUTH_KINDS`. */
function pluginManifestSchemaFor(deliverable: ReadonlySet<PluginMcpAuth['kind']>) {
  return (
    baseManifestSchema
      .refine((m) => Object.keys(m.mcpServers).length > 0, {
        message: 'declare at least one MCP server',
      })
      // The token grant stores one bearer for one server; a plugin is granted whole or not at all.
      .refine(
        (m) =>
          Object.keys(m.mcpServers).length === 1 ||
          Object.values(m.mcpServers).every((s) => !('auth' in s) || s.auth.kind !== 'user_token'),
        { message: 'a token-granted plugin declares exactly one server' },
      )
      .refine(
        (m) => Object.keys(m.frink.flowHeaders ?? {}).every((key) => httpServerKeys(m).has(key)),
        { message: 'flowHeaders must name a declared http server' },
      )
      // The lookup rides the plugin's own credential, so it can only run against a server Frink connects.
      .refine((m) => !m.frink.identity || httpServerKeys(m).has(m.frink.identity.server), {
        message: 'identity.server must name a declared http server',
      })
      // A node is reachable only through the plugin's registered http credential, and its id
      // must sit inside the plugin's reserved `<plugin>_` node namespace.
      .refine(
        (m) => {
          const actions = m.frink.actions ?? [];
          const ids = new Set(actions.map((action) => action.id));
          return (
            ids.size === actions.length &&
            actions.every(
              (action) =>
                action.id.startsWith(`${m.name}.`) &&
                action.id !== `${m.name}.${CALL_TOOL_ACTION}` &&
                httpServerKeys(m).has(action.server),
            )
          );
        },
        {
          message:
            'actions need unique `<name>.<action>` ids over a declared http server; `call_tool` is reserved',
        },
      )
  );
}

export const pluginManifestSchema = pluginManifestSchemaFor(DELIVERABLE_AUTH_KINDS);

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

/** Connectable when every server is http with auth the consent path delivers today; otherwise Coming soon. Consent itself is the user's proof. */
export function manifestAvailability(
  manifest: PluginManifest,
  deliverable: ReadonlySet<PluginMcpAuth['kind']> = DELIVERABLE_AUTH_KINDS,
): 'available' | 'coming_soon' {
  const servers = Object.values(manifest.mcpServers);
  return manifest.frink?.status !== 'coming_soon' &&
    servers.every((server) => 'url' in server && deliverable.has(server.auth.kind))
    ? 'available'
    : 'coming_soon';
}
