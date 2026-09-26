import { createContext, type ReactNode, useContext, useMemo } from 'react';

type ChatWorktreeValue = {
  worktreePath: string | null;
  chatId: string | null;
};

const DEFAULT_VALUE: ChatWorktreeValue = { worktreePath: null, chatId: null };

const CurrentChatWorktreeContext = createContext<ChatWorktreeValue>(DEFAULT_VALUE);

type CurrentChatWorktreeProviderProps = {
  children: ReactNode;
  worktreePath: string | null;
  chatId: string | null;
};

export function CurrentChatWorktreeProvider({
  children,
  worktreePath,
  chatId,
}: CurrentChatWorktreeProviderProps) {
  const value = useMemo(() => ({ worktreePath, chatId }), [worktreePath, chatId]);
  return (
    <CurrentChatWorktreeContext.Provider value={value}>
      {children}
    </CurrentChatWorktreeContext.Provider>
  );
}

/** Returns the current chat's worktree path, or null if outside provider or no worktree. */
export function useCurrentChatWorktree(): string | null {
  return useContext(CurrentChatWorktreeContext).worktreePath;
}

/** Returns the current chat's ID, or null if outside provider. */
export function useCurrentChatId(): string | null {
  return useContext(CurrentChatWorktreeContext).chatId;
}
