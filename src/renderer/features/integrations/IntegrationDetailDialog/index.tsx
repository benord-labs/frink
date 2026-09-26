/**
 * IntegrationDetailDialog Component
 * Shows integration details: account info, status, disconnect.
 * Trigger rule configuration has moved to the Webhook Trigger node in the flow editor.
 */

import { Button } from '@benord-labs/frink-primitives';
import { AlertTriangle, Trash2, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { getProviderById } from '../../../../shared/integrations/selectors';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { PluginMark } from '../../plugins';
import { trpc } from '../../../lib/trpc';
import type { ConnectedIntegration } from '../types';

type Props = {
  integration: ConnectedIntegration | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDisconnected: () => void;
  onRefetch: () => void;
};

export function IntegrationDetailDialog({
  integration,
  open,
  onOpenChange,
  onDisconnected,
  onRefetch,
}: Props) {
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

  const disconnect = trpc.integrations.disconnectIntegration.useMutation({
    onSuccess: (result) => {
      setShowDisconnectConfirm(false);
      onOpenChange(false);
      if (result.cleanupPending) {
        toast.warning('Disconnected locally. Provider connection cleanup is still pending.');
      }
      onDisconnected();
    },
    onError: (error) => {
      toast.error(`Failed to disconnect: ${error.message}`);
      onRefetch();
    },
  });

  if (!integration) return null;

  const integrationMeta = getProviderById(integration.provider);

  const handleDisconnect = () => {
    disconnect.mutate({ integrationId: integration.id });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <PluginMark
                pluginId={integration.provider}
                className="size-10 rounded-xl"
                markSize="1.375rem"
              />
              <div>
                <DialogTitle className="capitalize">
                  {integrationMeta?.display_name || integration.provider}
                </DialogTitle>
                <DialogDescription className="mt-1">
                  {integration.accountName
                    ? `${integration.accountName} - ${integration.accountIdentifier}`
                    : integration.accountIdentifier}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-6 py-4">
            {/* Disconnect */}
            <div className="border-t border-border pt-4">
              <Button
                variant="destructive"
                className="w-full"
                onClick={() => setShowDisconnectConfirm(true)}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Disconnect Integration
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDisconnectConfirm} onOpenChange={setShowDisconnectConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Disconnect {integrationMeta?.display_name || integration.provider}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the connection and deactivate all trigger rules for this integration.
              You can reconnect at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnect.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDisconnect}
              disabled={disconnect.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {disconnect.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Disconnecting...
                </>
              ) : (
                'Disconnect'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
