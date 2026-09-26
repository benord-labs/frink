import { Button } from '@benord-labs/frink-primitives';
import { useState } from 'react';
import { toast } from 'sonner';
import type { ResolvedPlugin } from '../../../../../shared/integrations/plugins';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../../components/ui/dropdown-menu';
import {
  type DisconnectMenuRow,
  disconnectMenuRows,
  isLifecyclePlugin,
} from '../../../../lib/plugins/plugin-disconnect-menu';
import { pluginNeedsGrant } from '../../../../lib/plugins/plugin-view-model';
import { usePluginRefresh } from '../../../../lib/plugins/use-plugin-refresh';
import { trpc } from '../../../../lib/trpc';
import { RemovePluginDialog, TurnOffPluginDialog } from '../PluginLifecycleDialogs';

/** One menu: the account's details above, the lifecycle (turn off / remove) beneath; Remove is the one Disconnect and revokes every grant. Turn on is a primary button while the plugin is off. */
export function PluginDisconnect({
  plugin,
  hasAccount,
  toolsConnected,
  onSelectAccount,
  connect,
}: {
  plugin: ResolvedPlugin;
  /** Any listed account, live or not. */
  hasAccount: boolean;
  toolsConnected: boolean;
  /** Opens the one live account's details; absent with several accounts. */
  onSelectAccount?: () => void;
  /** The connect chain, placed here while a grant is missing beside a live one. */
  connect?: { label: string; loading: boolean; describedBy?: string; onSelect: () => void };
}) {
  const [removeOpen, setRemoveOpen] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const refresh = usePluginRefresh();
  const setEnabled = trpc.plugins.setEnabled.useMutation({
    onSettled: refresh,
    onSuccess: () => toast.success(`${plugin.definition.name} turned on`),
    onError: (error) => toast.error(error.message),
  });

  const { id, name } = plugin.definition;
  const lifecycle = isLifecyclePlugin(plugin);
  const isEnabled = plugin.installation?.isEnabled === true;
  const rows = disconnectMenuRows({
    lifecycle,
    needsGrant: pluginNeedsGrant(plugin),
    isEnabled,
    hasAccount,
    toolsConnected,
    hasSingleAccount: Boolean(onSelectAccount),
    connectLabel: connect?.label,
  });
  if (rows.length === 0) return null;
  const select = (row: DisconnectMenuRow) => {
    if (row.kind === 'connect') connect?.onSelect();
    if (row.kind === 'account') onSelectAccount?.();
    if (row.kind === 'toggle') setPauseOpen(true);
    if (row.kind === 'remove') setRemoveOpen(true);
  };

  return (
    <>
      {plugin.installation?.isInstalled && !isEnabled ? (
        <Button
          size="sm"
          loading={setEnabled.isPending}
          aria-label={`Turn on ${name}`}
          onClick={() => setEnabled.mutate({ pluginId: id, enabled: true })}
        >
          Turn on
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            size="sm"
            loading={setEnabled.isPending || connect?.loading}
            aria-label={`More actions for ${name}`}
          >
            Manage
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {rows.map((row, index) =>
            row.kind === 'separator' ? (
              <DropdownMenuSeparator key={`sep-${index}`} />
            ) : (
              <DropdownMenuItem
                key={row.label}
                aria-describedby={row.kind === 'connect' ? connect?.describedBy : undefined}
                className={
                  row.kind === 'remove' ? 'text-destructive focus:text-destructive' : undefined
                }
                onSelect={() => select(row)}
              >
                {row.label}
              </DropdownMenuItem>
            ),
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <RemovePluginDialog plugin={plugin} open={removeOpen} onOpenChange={setRemoveOpen} />
      <TurnOffPluginDialog plugin={plugin} open={pauseOpen} onOpenChange={setPauseOpen} />
    </>
  );
}
