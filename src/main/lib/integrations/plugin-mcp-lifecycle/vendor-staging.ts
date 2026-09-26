/** Puts a pinned vendor package on disk — the step install and Turn on share. */
import { TRPCError } from '@trpc/server';
import { vendorPluginPin } from '../../../../shared/integrations/vendor-plugin-pins';
import {
  installVendorPlugin,
  installVendorPluginFromLocalClaudeCache,
  restageVendorPlugin,
} from '../../claude/session-config-dir';
import {
  acquireVendorClaudePlugin,
  cleanupAcquiredPayload,
} from '../../claude/vendor-plugin-acquire';

/** Stage the full pinned vendor package before reporting a successful install or enable. */
export async function stageVendorPlugin(pluginId: string): Promise<void> {
  const pin = vendorPluginPin(pluginId);
  if (!pin || restageVendorPlugin(pin) || installVendorPluginFromLocalClaudeCache(pin)) return;
  const acquired = await acquireVendorClaudePlugin(pin);
  if (!acquired.ok) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Could not install the official ${pin.name} plugin: ${acquired.reason}`,
    });
  }
  try {
    installVendorPlugin({
      sourceDir: acquired.sourceDir,
      marketplaceDir: acquired.marketplaceDir,
      plugin: pin,
    });
  } finally {
    cleanupAcquiredPayload(pin);
  }
}
