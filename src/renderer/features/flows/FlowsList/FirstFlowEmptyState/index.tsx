import { Button } from '@benord-labs/frink-primitives';
import { useSetAtom } from 'jotai';
import { GitBranch, Play, Zap } from 'lucide-react';
import type { ReactElement } from 'react';
import { toast } from 'sonner';
import { seedNewChatPromptAtom } from '@/features/agents';
import { useValidatedProject } from '../../../../hooks/use-validated-project';
import { useNewChatAccount } from '../../../../lib/hooks/use-new-chat-account';
import { trpc } from '../../../../lib/trpc';
import { cn } from '../../../../lib/utils';

export const FIRST_FLOW_PROMPT =
  "Help me set up my first Flow. Ask me what I'd like to automate, suggest a simple flow that fits, then build it for me.";

type Props = {
  onCreateClick: () => void;
  /** Leaves Flows and shows the chat where the user is working, in single or split view. */
  onOpenChat: (chatId: string) => void;
};

/** The Flows dashboard with no flows: hand the first flow to an agent, or start a blank one. */
export function FirstFlowEmptyState({ onCreateClick, onOpenChat }: Props): ReactElement {
  const { validatedProject } = useValidatedProject();
  const { account, accountLoading, pickedAccountId } = useNewChatAccount(validatedProject?.id);
  const seedNewChatPrompt = useSetAtom(seedNewChatPromptAtom);
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
  const startChat = () => {
    // Without a signed-in AI (or if the lookup failed) nothing would reply, so New Chat takes over.
    if (!account?.isAuthenticated) return seedNewChatPrompt(FIRST_FLOW_PROMPT);
    createChat.mutate(
      {
        projectId: validatedProject?.id,
        projectPath: validatedProject?.path,
        accountId: pickedAccountId,
        initialMessage: FIRST_FLOW_PROMPT,
        useWorktree: false,
      },
      { onSuccess: (chat) => onOpenChat(chat.id) },
    );
  };

  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <div
        className={cn(
          'group flex w-full max-w-sm flex-col items-center rounded-xl border-2 border-dashed border-border/45 p-10 text-center',
          'transition-all duration-300 hover:border-border/60 hover:bg-muted/15',
        )}
      >
        <div className="flex justify-center mb-5 isolate">
          <div className="glass-card size-10 grid place-items-center rounded-xl relative left-2 top-1 -rotate-6 shadow-md ring-1 ring-border/60 group-hover:-translate-x-4 group-hover:-rotate-12 group-hover:-translate-y-0.5 transition-all duration-300">
            <GitBranch className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="glass-card size-10 grid place-items-center rounded-xl relative z-10 shadow-md ring-1 ring-border/60 group-hover:-translate-y-1 transition-all duration-300">
            <Zap className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="glass-card size-10 grid place-items-center rounded-xl relative right-2 top-1 rotate-6 shadow-md ring-1 ring-border/60 group-hover:translate-x-4 group-hover:rotate-12 group-hover:-translate-y-0.5 transition-all duration-300">
            <Play className="h-5 w-5 text-muted-foreground" />
          </div>
        </div>
        <p className="text-base font-medium">No flows yet</p>
        <p className="text-sm text-muted-foreground mt-1 mb-5 max-w-[260px]">
          Flows run steps for you automatically: on a schedule, when something happens, or when you
          ask.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button size="sm" loading={createChat.isPending || accountLoading} onClick={startChat}>
            Build with AI
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="shadow-xs"
            disabled={createChat.isPending}
            onClick={onCreateClick}
          >
            Start from scratch
          </Button>
        </div>
      </div>
    </div>
  );
}
