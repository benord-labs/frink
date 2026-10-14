/** SecretRequestCard: the secure form for `frink_request_secret`. The value stays in local state and
 * goes to main through the plain tRPC client; main saves it and tells the agent in one step. */
import { Button, Input } from '@benord-labs/frink-primitives';
import { KeyRound } from 'lucide-react';
import { type FormEvent, memo, type ReactNode, useEffect, useState } from 'react';
import type { TaskResultRecord } from '../../../../../../../shared/types/task-result';
import type { SecretRequest } from '../../../../../../../shared/types/task-signal';
import { deriveParkSurfaceState } from '../../../../../../lib/agent-chat/flow-chat-surface-state';
import { trpc } from '../../../../../../lib/trpc';
import { agentsChatComposerShellClass } from '../../../chat-composer-shell-classes';

type Props = {
  request: SecretRequest;
  subChatId: string;
  /** The parked task carrying the request; null for a chat with no task. */
  taskId: string | null;
  /** Called once main has answered the request and told the agent, so the caller can drop the card. */
  onSettled: () => void;
};

function gitNote(git: SecretRequest['git']): string | null {
  if (git === 'untracked') return 'Frink will keep this file out of git on this computer.';
  if (git === 'tracked') return 'Git tracks this file, so a commit would include the value.';
  return null;
}

export const SecretRequestCard = memo(function SecretRequestCard({
  request,
  subChatId,
  taskId,
  onSettled,
}: Props) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isFocused, setIsFocused] = useState(false);
  const { client } = trpc.useUtils();

  const finish = async (save: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const ref = { subChatId, requestId: request.id, taskId };
      if (save) await client.secretRequests.submit.mutate({ ...ref, value });
      else await client.secretRequests.decline.mutate(ref);
      setValue('');
      // Stays busy: the request is answered, and the card goes once the caller drops it.
      onSettled();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Frink could not save it.');
      setBusy(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (value && !busy) void finish(true);
  };

  const note = gitNote(request.git);
  return (
    <div className="relative z-20 min-w-0 px-2 pb-2">
      <div className="mx-auto w-full max-w-2xl">
        <div className={agentsChatComposerShellClass(false, isFocused)}>
          <div className="flex items-start gap-2">
            <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium">
                The agent needs <code className="font-mono">{request.name}</code>
              </p>
              <p className="text-sm text-muted-foreground">The agent says: {request.reason}</p>
            </div>
          </div>
          <form className="mt-3 flex items-center gap-2" onSubmit={onSubmit}>
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              disabled={busy}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder="Paste the value here"
              aria-label={`Value for ${request.name}`}
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void finish(false)}
            >
              Don&apos;t save
            </Button>
            <Button type="submit" size="sm" disabled={busy || !value}>
              Save
            </Button>
          </form>
          <ul className="mt-2 space-y-0.5 text-sm text-muted-foreground">
            <li>
              Saves to <code className="font-mono">{request.file}</code>
              {request.replaces ? ', replacing the value already there.' : '.'}
            </li>
            {note ? <li>{note}</li> : null}
            <li>
              Frink saves this straight to the file and does not send it to the model. Programs the
              agent runs can still read the file.
            </li>
          </ul>
          {error ? (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
});

type DrivingTask = { id: string; status: string; result?: TaskResultRecord | null } | null;

/**
 * The secret request waiting on the user: the one parking the driving task, else the live request
 * of a chat with no task (refetched when a turn ends, since that is when an agent asks).
 */
function useOpenSecretRequest(subChatId: string, task: DrivingTask, isTurnActive: boolean) {
  const surface = deriveParkSurfaceState(task);
  const parked = surface.kind === 'secret';
  const utils = trpc.useUtils();
  const live = trpc.secretRequests.pending.useQuery({ subChatId }, { enabled: !parked });
  const { refetch } = live;

  useEffect(() => {
    if (!isTurnActive && !parked) void refetch();
  }, [isTurnActive, parked, refetch]);

  const open =
    surface.kind === 'secret'
      ? { request: surface.request, taskId: task?.id ?? null }
      : live.data
        ? { request: live.data, taskId: null }
        : null;
  const settle = () => void utils.secretRequests.pending.invalidate({ subChatId });
  return { open, settle };
}

type GateProps = {
  subChatId: string;
  task: DrivingTask;
  isTurnActive: boolean;
  /** Kept above the card (a live question card); everything in `children` is replaced. */
  above: ReactNode;
  children: ReactNode;
};

/** Swaps `children` (composer or park surface) for the form while a request is open and no turn
 * runs; a running turn keeps `children`, and with it the composer's Stop. */
export const SecretRequestGate = memo(function SecretRequestGate({
  subChatId,
  task,
  isTurnActive,
  above,
  children,
}: GateProps) {
  const { open, settle } = useOpenSecretRequest(subChatId, task, isTurnActive);
  if (!open || isTurnActive) return <>{children}</>;
  return (
    <>
      {above}
      <SecretRequestCard
        key={open.request.id}
        request={open.request}
        subChatId={subChatId}
        taskId={open.taskId}
        onSettled={settle}
      />
    </>
  );
});
