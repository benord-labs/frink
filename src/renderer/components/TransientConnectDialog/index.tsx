import { Button } from '@benord-labs/frink-primitives';
import { ExternalLink, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CopyableInput } from '../CopyableInput';

/** An in-flight consent's sign-in page, plus whether the system browser actually opened it. */
export type ConnectLinkState = {
  url: string;
  browserLaunchFailed: boolean;
};

/** One declared grant on the dialog's checklist and whether it has landed. */
export type ConnectChecklistRow = { done: boolean };

/** The connecting plugin: the id + name of the plugin whose consent runs in the system browser. */
type ConnectingProvider = { id: string; display_name: string };

type TransientConnectDialogProps = {
  connectingProvider: string | null;
  connectError: string | null;
  connectLink: ConnectLinkState | null;
  /** The plugin's declared grants, in chain order; empty until the chain knows them. */
  checklist: readonly ConnectChecklistRow[];
  provider: ConnectingProvider | undefined;
  onClose: () => void;
  onRetry: (providerId: string) => void;
};

function dialogCopy(
  connectError: string | null,
  provider: ConnectingProvider | undefined,
  finishing: boolean,
  preparing: boolean,
) {
  if (connectError) {
    return {
      title: 'Connection Failed',
      description: `There was a problem connecting your ${provider?.display_name ?? 'integration'} account.`,
    };
  }
  if (finishing) {
    return {
      title: 'Finishing setup',
      description: `You're signed in to ${provider?.display_name ?? 'your account'}. You can close the browser tab.`,
    };
  }
  return {
    title: `Connecting ${provider?.display_name ?? ''}...`,
    description: preparing
      ? 'Preparing your sign-in…'
      : 'Finish signing in using the browser link below.',
  };
}

/** One row per declared grant; a row still waiting when the chain failed reads Cancelled. */
function GrantChecklist({
  rows,
  provider,
  failed,
  preparing,
}: {
  rows: readonly ConnectChecklistRow[];
  provider: ConnectingProvider | undefined;
  failed: boolean;
  preparing: boolean;
}) {
  if (rows.length === 0) return null;
  const vendor = provider?.display_name ?? 'this service';
  return (
    <div className="mb-5 text-left">
      <ul className="space-y-1.5" aria-label="Sign-in steps">
        {rows.map((row, index) => (
          <li key={index} className="flex items-center justify-between gap-3 text-sm">
            <span>Sign in to {vendor}</span>
            <span className={!row.done && failed ? 'text-destructive' : 'text-muted-foreground'}>
              {row.done
                ? 'Done'
                : failed
                  ? 'Cancelled'
                  : preparing
                    ? 'Preparing…'
                    : 'Waiting for you in the browser…'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The sign-in page for copy-paste, for when the browser tab never opened or got lost. */
function ConnectLinkRow({ url, launchFailed }: { url: string; launchFailed: boolean }) {
  return (
    <div className="mt-4 space-y-2 text-left">
      <CopyableInput
        value={url}
        label={
          launchFailed
            ? 'Copy this link and paste it into your browser to finish signing in.'
            : "If the page didn't open, copy this link into your browser."
        }
      />
      {/* Offered only while the browser is believed to work; after a failed launch the link is the reliable path. */}
      {!launchFailed && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void window.desktopApi.openExternal(url)}
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          Open the sign-in page again
        </Button>
      )}
    </div>
  );
}

/** In-flight connect dialog; `onClose` is the one Cancel/Close/Esc/backdrop path and also abandons the chain, so the chain's owner supplies it. */
export function TransientConnectDialog({
  connectingProvider,
  connectError,
  connectLink,
  checklist,
  provider,
  onClose,
  onRetry,
}: TransientConnectDialogProps) {
  const launchFailed = connectLink?.browserLaunchFailed ?? false;
  const finishing = !connectError && checklist.length > 0 && checklist.every((row) => row.done);
  const preparing = !connectLink;
  const { title, description } = dialogCopy(connectError, provider, finishing, preparing);

  return (
    <Dialog
      open={Boolean(connectingProvider) || Boolean(connectError)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="py-6 text-center">
          <GrantChecklist
            rows={checklist}
            provider={provider}
            failed={Boolean(connectError)}
            preparing={preparing}
          />
          {connectError ? (
            <p className="text-sm text-destructive" role="alert">
              {connectError}
            </p>
          ) : (
            <>
              {finishing ? (
                <>
                  <Loader2 className="h-8 w-8 mx-auto mb-3 animate-spin" aria-hidden="true" />
                  <p className="text-sm text-muted-foreground" role="status">
                    Setting up your connection…
                  </p>
                </>
              ) : launchFailed ? (
                <p className="text-sm font-medium" role="alert">
                  Frink couldn't open your browser. Copy the link below to finish signing in.
                </p>
              ) : (
                <>
                  <Loader2 className="h-8 w-8 mx-auto mb-3 animate-spin" aria-hidden="true" />
                  <p className="text-sm text-muted-foreground" role="status">
                    {preparing
                      ? 'Your browser will open when the connection is ready.'
                      : "A browser tab should have opened. Come back to Frink when the page says you're done."}
                  </p>
                </>
              )}
              {connectLink && !finishing && (
                <ConnectLinkRow url={connectLink.url} launchFailed={launchFailed} />
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {connectError ? 'Close' : 'Cancel'}
          </Button>
          {connectError && provider && (
            // Retries through the plugin handler so a failed install is retried too (install is an idempotent upsert).
            <Button onClick={() => onRetry(provider.id)}>Try Again</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
