import { Button } from '@benord-labs/frink-primitives';
import { useState } from 'react';
import { toast } from 'sonner';
import type { PluginMcpAuth } from '../../../../../shared/integrations/plugins';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../../components/ui/dialog';
import { Label } from '../../../../components/ui/label';
import { trpc } from '../../../../lib/trpc';

type Props = {
  pluginId: string;
  name: string;
  auth: Extract<PluginMcpAuth, { kind: 'user_token' }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The leg that follows a saved token (the account sign-in); absent when the token is the whole connect. */
  onConnected?: () => void;
};

/** One-field grant for a server with no OAuth path: the token is checked with the vendor before Frink keeps it. */
export function PluginTokenDialog({
  pluginId,
  name,
  auth,
  open,
  onOpenChange,
  onConnected,
}: Props) {
  const [token, setToken] = useState('');
  const utils = trpc.useUtils();
  const connect = trpc.plugins.connectUserToken.useMutation({
    onSuccess: () => {
      setToken('');
      onOpenChange(false);
      if (!onConnected) return;
      toast.success(
        `Token saved. Next, sign in to ${name} in your browser so ${name} can notify Frink.`,
      );
      onConnected();
    },
    onSettled: () => void utils.plugins.vendorMcpStatus.invalidate(),
  });
  const inputId = `plugin-token-${pluginId}`;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!connect.isPending) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {name}</DialogTitle>
          <DialogDescription>
            Paste a personal access token. Frink checks it with {name} once, then keeps it for your
            chats. It is stored only on this Mac.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            connect.mutate({ pluginId, token });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={inputId}>Token</Label>
            <input
              id={inputId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              className="h-9 w-full rounded-md border border-field-border bg-surface px-3 text-ink text-sm placeholder:text-dim focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {connect.error ? (
            <p role="alert" className="text-destructive text-sm">
              {connect.error.message}
            </p>
          ) : null}
          <DialogFooter className="items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => window.desktopApi.openExternal(auth.setupUrl)}
            >
              Create a token
            </Button>
            <Button
              type="submit"
              size="sm"
              loading={connect.isPending}
              disabled={token.trim() === ''}
            >
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
