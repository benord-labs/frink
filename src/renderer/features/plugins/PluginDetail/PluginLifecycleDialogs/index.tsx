import { toast } from 'sonner';
import { isInstallablePluginId } from '../../../../../shared/integrations/installable-plugins';
import type { ResolvedPlugin } from '../../../../../shared/integrations/plugins';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../../components/ui/alert-dialog';
import { connectionLabel, hasChatMcp } from '../../../../lib/plugins/plugin-view-model';
import { usePluginRefresh } from '../../../../lib/plugins/use-plugin-refresh';
import { trpc } from '../../../../lib/trpc';

type DialogProps = { plugin: ResolvedPlugin; open: boolean; onOpenChange: (open: boolean) => void };

/** Uninstall: disconnects every account, forgets the MCP authorization, removes the plugin. */
export function RemovePluginDialog({ plugin, open, onOpenChange }: DialogProps) {
  const refresh = usePluginRefresh();
  const uninstall = trpc.plugins.uninstall.useMutation({
    onSettled: refresh,
    onSuccess: () => {
      onOpenChange(false);
      toast.success(`${plugin.definition.name} removed`);
    },
    onError: (error) => toast.error(error.message),
  });
  const { id, name } = plugin.definition;
  const accounts = plugin.connections.filter((connection) => connection.isActive);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!uninstall.isPending) onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              {accounts.length > 0 ? (
                <p>
                  {accounts.map((connection) => connectionLabel(connection)).join(', ')}{' '}
                  {accounts.length === 1 ? 'gets' : 'get'} disconnected first.
                </p>
              ) : null}
              {hasChatMcp(plugin.definition) ? (
                <p>
                  Chats stop offering this plugin&apos;s tools the next time each chat starts a
                  session; a chat that is mid-session keeps them until then. Your previous tool
                  approvals are kept if you reinstall.
                </p>
              ) : (
                <p>Its webhook addresses stop accepting events. Your Flows are kept.</p>
              )}
              {hasChatMcp(plugin.definition) ? (
                <p>
                  Frink forgets its MCP authorization for {name}. {name} itself still lists the
                  grant — revoke it at the provider if you want it gone there too.
                </p>
              ) : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={uninstall.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={uninstall.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(event) => {
              event.preventDefault();
              if (isInstallablePluginId(id)) uninstall.mutate({ pluginId: id });
            }}
          >
            {uninstall.isPending ? 'Removing…' : 'Remove'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Pause: flows stop starting and new chats stop offering the tools; accounts stay connected. */
export function TurnOffPluginDialog({ plugin, open, onOpenChange }: DialogProps) {
  const refresh = usePluginRefresh();
  const setEnabled = trpc.plugins.setEnabled.useMutation({
    onSettled: refresh,
    onSuccess: () => {
      onOpenChange(false);
      toast.success(`${plugin.definition.name} turned off`);
    },
    onError: (error) => toast.error(error.message),
  });
  const { id, name } = plugin.definition;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!setEnabled.isPending) onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Turn off {name}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Flows using {name} stop starting. Accounts stay connected.
                {hasChatMcp(plugin.definition)
                  ? ' New chats stop offering its tools; a chat mid-session keeps them until it ends.'
                  : ''}
              </p>
              <p>Turn it back on any time — nothing is removed.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={setEnabled.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={setEnabled.isPending}
            onClick={(event) => {
              event.preventDefault();
              if (isInstallablePluginId(id)) setEnabled.mutate({ pluginId: id, enabled: false });
            }}
          >
            {setEnabled.isPending ? 'Turning off…' : 'Turn off'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
