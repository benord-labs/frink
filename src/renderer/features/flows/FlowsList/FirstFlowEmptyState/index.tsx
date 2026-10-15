import { Button } from '@benord-labs/frink-primitives';
import { MessageSquare, type LucideIcon, Workflow } from 'lucide-react';
import { type ReactElement, type ReactNode, useId } from 'react';
import { toast } from 'sonner';
import { useValidatedProject } from '../../../../hooks/use-validated-project';
import { trpc } from '../../../../lib/trpc';

export const FIRST_FLOW_PROMPT =
  "Help me set up my first Flow. Ask me what I'd like to automate, suggest a simple flow that fits, then build it for me.";

/** The same glass list as the "Connect an AI to get started" screen. */
const LIST_CLASS =
  'divide-y divide-border/60 overflow-hidden rounded-2xl border border-border glass-float shadow-xs ring-1 ring-inset ring-foreground/4';

function OptionRow({
  icon: Icon,
  name,
  detail,
  action,
}: {
  icon: LucideIcon;
  name: string;
  detail: string;
  action: ReactNode;
}): ReactElement {
  return (
    <li className="flex items-center gap-3 px-4 py-3.5">
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-muted text-foreground shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)]"
      >
        <Icon className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{name}</p>
        <p className="truncate text-sm text-muted-foreground">{detail}</p>
      </div>
      {action}
    </li>
  );
}

type Props = {
  onCreateClick: () => void;
  /** Leaves Flows and shows the chat where the user is working, in single or split view. */
  onOpenChat: (chatId: string) => void;
};

/** The Flows dashboard with no flows: hand the first flow to an agent, or start a blank one. */
export function FirstFlowEmptyState({ onCreateClick, onOpenChat }: Props): ReactElement {
  const headingId = useId();
  const { validatedProject } = useValidatedProject();
  const utils = trpc.useUtils();
  const createChat = trpc.chats.create.useMutation({
    onSuccess: () => {
      void utils.chats.list.invalidate();
      void utils.chats.listCounts.invalidate();
      void utils.chats.listByFolder.invalidate();
    },
    onError: () => toast.error("Couldn't start the chat", { description: 'Please try again.' }),
  });

  // Navigation rides the per-call callback, which never fires once Flows has unmounted, so a user
  // who already left is not pulled into the chat.
  const startChat = () =>
    createChat.mutate(
      {
        projectId: validatedProject?.id,
        projectPath: validatedProject?.path,
        initialMessage: FIRST_FLOW_PROMPT,
        useWorktree: false,
      },
      { onSuccess: (chat) => onOpenChat(chat.id) },
    );

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-1 flex-col items-center justify-center px-4 pb-16"
    >
      <h2
        id={headingId}
        className="text-center text-2xl font-medium tracking-tight text-balance text-foreground"
      >
        Automate your first task
      </h2>
      <p className="mt-3 text-center text-[15px] text-muted-foreground text-pretty">
        Flows run steps for you on a schedule, when something happens, or when you ask.
      </p>
      <ul className={`mt-8 w-full max-w-lg ${LIST_CLASS}`}>
        <OptionRow
          icon={MessageSquare}
          name="Build it with AI"
          detail="Describe it and an agent sets it up"
          action={
            <Button
              aria-label="Start building with AI"
              loading={createChat.isPending}
              onClick={startChat}
            >
              Start
            </Button>
          }
        />
        <OptionRow
          icon={Workflow}
          name="Start from scratch"
          detail="Add a trigger and steps yourself"
          action={
            <Button
              variant="secondary"
              aria-label="Create a blank flow"
              disabled={createChat.isPending}
              onClick={onCreateClick}
            >
              Create
            </Button>
          }
        />
      </ul>
    </section>
  );
}
