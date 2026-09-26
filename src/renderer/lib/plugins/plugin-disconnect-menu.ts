import { isInstallablePluginId } from '../../../shared/integrations/installable-plugins';
import type { ResolvedPlugin } from '../../../shared/integrations/plugins';

/** Builtin plugin the lifecycle router accepts, installed or still holding an account from an older install: Remove sweeps either — the one predicate the header and the menu share. */
export function isLifecyclePlugin(plugin: ResolvedPlugin): boolean {
  return (
    (plugin.installation?.isInstalled === true || plugin.connections.length > 0) &&
    plugin.definition.source.kind === 'frink_builtin' &&
    isInstallablePluginId(plugin.definition.id)
  );
}

/** The Manage menu as data, so the component only maps rows to items. */
export type DisconnectMenuRow =
  | { kind: 'connect'; label: string }
  | { kind: 'account'; label: 'Account details' }
  | { kind: 'separator' }
  | { kind: 'toggle'; label: 'Turn off plugin' }
  | { kind: 'remove'; label: 'Remove plugin' };

export function disconnectMenuRows(input: {
  /** Installed builtin plugin: grants can be revoked and the lifecycle is offered. */
  lifecycle: boolean;
  isEnabled: boolean;
  /** Any listed account, live or not: an account in trouble still needs its lifecycle. */
  hasAccount: boolean;
  /** The tools grant is live — for a chat-only plugin, its only connection. */
  toolsConnected: boolean;
  hasSingleAccount: boolean;
  /** Account-free packages are usable immediately after installation. */
  needsGrant: boolean;
  /** The connect action's label when it is placed in this menu (a grant still missing beside a live one). */
  connectLabel?: string;
}): DisconnectMenuRow[] {
  const rows: DisconnectMenuRow[] = [];
  if (input.connectLabel) rows.push({ kind: 'connect', label: input.connectLabel });
  if (input.hasSingleAccount) rows.push({ kind: 'account', label: 'Account details' });
  if (!input.lifecycle) return rows;
  // All-or-nothing: on with nothing connected means Connect is the only action.
  if (input.isEnabled && input.needsGrant && !input.hasAccount && !input.toolsConnected)
    return rows;
  if (rows.length > 0) rows.push({ kind: 'separator' });
  // Turn on is the header's primary button while off, so the menu never offers it twice.
  if (input.isEnabled) rows.push({ kind: 'toggle', label: 'Turn off plugin' });
  rows.push({ kind: 'remove', label: 'Remove plugin' });
  return rows;
}
