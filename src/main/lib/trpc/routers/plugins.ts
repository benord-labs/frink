import {
  installWebhookPlugin,
  setWebhookPluginEnabled,
  uninstallWebhookPlugin,
} from '../../integrations/plugin-webhook-lifecycle';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  type PluginInstallationSnapshot,
  resolvePlugins,
} from '../../../../shared/integrations/plugins';
import {
  isInstallablePluginId,
  isWebhookPluginId,
  isMcpPluginId,
} from '../../../../shared/integrations/installable-plugins';
import { getDatabase } from '../../db';
import { listInstallations as listPluginInstallations } from '../../db/repos/plugin-installations';
import { listLocalIntegrations } from '../../db/repos/webhook-ingress';
import { localEndpointIo } from '../../webhooks';
import {
  unwindUnconnectedInstall,
  withGrantUnwind,
} from '../../integrations/plugin-connect-unwind';
import {
  grantUserToken,
  installMcpPlugin,
  setMcpPluginEnabled,
  uninstallMcpPlugin,
} from '../../integrations/plugin-mcp-lifecycle';
import { vendorPluginMcpStatus } from '../../mcp/runtime/vendor-plugin-mcp-status';
import { cancelVendorPluginMcpConsent } from '../../mcp/runtime/vendor-plugin-oauth';
import { publicProcedure, publicProcedureRaw, router } from '../index';

/** Any plugin the lifecycle accepts; each mutation dispatches on its kind. */
const installablePluginId = z.string().refine(isInstallablePluginId, 'Unknown plugin');

function toInstallationSnapshot(
  row: Awaited<ReturnType<typeof listPluginInstallations>>[number],
): PluginInstallationSnapshot {
  if (row.sourceKind !== 'frink_builtin' && row.sourceKind !== 'agent_plugins_v1') {
    throw new Error(`Unsupported plugin installation source kind: ${row.sourceKind}`);
  }
  return {
    id: row.id,
    pluginId: row.pluginId,
    sourceKind: row.sourceKind,
    sourceLocator: row.sourceLocator,
    installedVersion: row.installedVersion,
    isInstalled: row.isInstalled,
    isEnabled: row.isEnabled,
  };
}

export const pluginsRouter = router({
  /**
   * Raw on purpose. Nothing here is snake_case — every key is hand-built by
   * `resolvePlugins` and `toInstallationSnapshot` — so `caseConvertOutput` has
   * nothing to fix and one thing to break: it
   * rewrites *kebab* keys too, and `runtimeSupport` is keyed by runtime id, so
   * `claude-code` arrived as `claudeCode`. The declared type still said
   * `claude-code`, so it type-checked and threw on first read in the renderer.
   */
  list: publicProcedureRaw.query(async () => {
    const installations = await listPluginInstallations(getDatabase());
    const accounts = await listLocalIntegrations(getDatabase());

    return {
      plugins: resolvePlugins({
        installations: installations.map(toInstallationSnapshot),
        connections: accounts.map((row) => ({
          id: row.id,
          providerId: row.provider,
          isActive: row.isActive,
        })),
      }),
    };
  }),

  install: publicProcedure
    .input(z.object({ pluginId: installablePluginId }))
    .mutation(async ({ input }) => {
      const { pluginId } = input;
      const installation = isWebhookPluginId(pluginId)
        ? await installWebhookPlugin(getDatabase(), localEndpointIo(), pluginId)
        : (await installMcpPlugin(getDatabase(), pluginId)).installation;
      return { installation: toInstallationSnapshot(installation) };
    }),

  uninstall: publicProcedure
    .input(z.object({ pluginId: installablePluginId }))
    .mutation(async ({ input }) => {
      const { pluginId } = input;
      const tombstone = isWebhookPluginId(pluginId)
        ? await uninstallWebhookPlugin(getDatabase(), pluginId)
        : await uninstallMcpPlugin(getDatabase(), pluginId);
      return { installation: tombstone ? toInstallationSnapshot(tombstone) : null };
    }),

  /** The renderer owns the end of a browser OAuth attempt: a timeout or cancel that connected nothing leaves no install behind. */
  connectAttemptEnded: publicProcedure
    .input(z.object({ pluginId: installablePluginId }))
    .mutation(async ({ input }) => {
      await cancelVendorPluginMcpConsent(input.pluginId);
      await unwindUnconnectedInstall(getDatabase(), input.pluginId);
    }),

  setEnabled: publicProcedure
    .input(z.object({ pluginId: installablePluginId, enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      const { pluginId, enabled } = input;
      const installation = isWebhookPluginId(pluginId)
        ? await setWebhookPluginEnabled(getDatabase(), pluginId, enabled)
        : await setMcpPluginEnabled(getDatabase(), pluginId, enabled);
      return { installation: toInstallationSnapshot(installation) };
    }),

  vendorMcpStatus: publicProcedure.query(() => vendorPluginMcpStatus()),

  /** Connect for a chat-only catalog plugin: install (idempotent), then the browser consent; a consent that lands nothing unwinds. */
  connectVendorMcp: publicProcedure
    .input(
      z.object({
        pluginName: z.string().refine(isMcpPluginId, 'Unknown plugin'),
        reconnect: z.boolean().optional(),
      }),
    )
    .mutation(({ input }) =>
      withGrantUnwind(
        getDatabase(),
        input.pluginName,
        async () =>
          (await installMcpPlugin(getDatabase(), input.pluginName, { reconnect: input.reconnect }))
            .consent,
      ),
    ),

  /** Token grant for a server with no OAuth path (GitHub): validated against the vendor before it is stored; a rejected token unwinds. */
  connectUserToken: publicProcedure
    .input(
      z.object({
        pluginId: installablePluginId.refine(
          (id) => !isWebhookPluginId(id),
          'This plugin does not use a token.',
        ),
        token: z.string().trim().min(1),
      }),
    )
    .mutation(({ input }) =>
      withGrantUnwind(getDatabase(), input.pluginId, () =>
        grantUserToken(getDatabase(), input.pluginId, input.token),
      ),
    ),
});
