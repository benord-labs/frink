/* eslint-disable max-lines, max-lines-per-function */
/**
 * API bridge for desktop app
 * Wraps real tRPC calls and provides stubs for web-only features
 */

import { useMemo } from 'react';
import { trpc } from './trpc';

type AnyFn = (...args: unknown[]) => unknown;
type AnyObj = Record<string, unknown>;
type SubChatModeVariables = { subChatId: string; mode: 'plan' | 'agent' | 'debug' };
type SubChatModeResult = Exclude<
  ReturnType<typeof trpc.chats.updateSubChatMode.useMutation>['data'],
  undefined
>;

// Chat list item type (from chats.list router)
type ChatListItem = {
  id: string;
  name: string | null;
  projectId: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  prUrl: string | null;
  prNumber: number | null;
  taskId: string | null;
};

// Chat with subChats type (from chats.get router)
type _ChatWithSubChats = {
  id: string;
  name: string | null;
  projectId: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  prUrl: string | null;
  prNumber: number | null;
  taskId: string | null;
  subChats: Array<{
    id: string;
    name: string | null;
    chatId: string;
    sessionId: string | null;
    streamId: string | null;
    mode: 'plan' | 'agent' | 'debug';
    messages: string;
    createdAt: Date;
    updatedAt: Date;
    additions: number;
    deletions: number;
    fileCount: number;
  }>;
  project: {
    id: string;
    name: string;
    path: string;
    gitRemoteUrl: string | null;
  } | null;
};

type SetDataUpdater<_TData> = Parameters<
  ReturnType<typeof trpc.useUtils>['chats']['list']['setData']
>[1];

export const api = {
  agents: {
    getAgentChats: {
      useQuery: (_args?: AnyObj, _opts?: AnyObj) => {
        // Use real tRPC
        const result = trpc.chats.list.useQuery({});
        return {
          data: result.data ?? [],
          isLoading: result.isLoading,
        };
      },
    },
    getAgentChat: {
      useQuery: (args?: { chatId: string }, opts?: AnyObj) => {
        const chatId = args?.chatId;
        const result = trpc.chats.get.useQuery(
          { id: chatId ?? '' },
          { enabled: !!chatId && opts?.enabled !== false },
        );

        // Memoize transformation to prevent infinite re-renders
        const transformedData = useMemo(() => {
          if (!result.data) return null;
          return {
            ...result.data,
            // Desktop uses worktrees, not sandboxes
            sandboxId: null,
            meta: null,
            // Map subChats to expected format
            subChats: result.data.subChats?.map((sc: AnyObj) => {
              let parsedMessages: AnyObj[] = [];
              try {
                // sc.messages is a string (JSON) from the database
                const messagesStr = typeof sc.messages === 'string' ? sc.messages : null;
                parsedMessages = messagesStr ? JSON.parse(messagesStr) : [];
                // Transform old tool-invocation parts to new tool-{toolName} format
                parsedMessages = parsedMessages.map((msg: AnyObj) => {
                  // msg.parts should be an array
                  if (!Array.isArray(msg.parts)) return msg;
                  return {
                    ...msg,
                    parts: msg.parts.map((part: AnyObj) => {
                      // Migrate old "tool-invocation" type to "tool-{toolName}"
                      if (
                        typeof part.type === 'string' &&
                        part.type === 'tool-invocation' &&
                        part.toolName
                      ) {
                        return {
                          ...part,
                          type: `tool-${part.toolName}`,
                          toolCallId: part.toolCallId || part.toolInvocationId,
                          input: part.input || part.args,
                        };
                      }
                      return part;
                    }),
                  };
                });
              } catch {
                parsedMessages = [];
              }
              return {
                ...sc,
                createdAt: sc.createdAt,
                updatedAt: sc.updatedAt,
                messages: parsedMessages,
                streamId: null,
              };
            }),
          };
        }, [result.data]);

        return {
          data: transformedData,
          isLoading: result.isLoading,
        };
      },
    },
    getArchivedChats: {
      useQuery: (_args?: AnyObj, _opts?: AnyObj) => {
        const result = trpc.chats.listArchived.useQuery(undefined);
        return {
          data: result.data ?? [],
          isLoading: result.isLoading,
        };
      },
    },
    archiveChat: {
      useMutation: (opts?: { onMutate?: AnyFn; onError?: AnyFn; onSettled?: AnyFn }) => {
        const mutation = trpc.chats.archive.useMutation({
          onSuccess: () => opts?.onSettled?.(),
          onError: (err) => opts?.onError?.(err),
        });
        return {
          mutate: async (args?: { chatId: string }) => {
            const context = await opts?.onMutate?.(args);
            if (args?.chatId) {
              mutation.mutate({ id: args.chatId });
            }
            return context;
          },
          isPending: mutation.isPending,
        };
      },
    },
    restoreChat: {
      useMutation: (opts?: { onMutate?: AnyFn; onError?: AnyFn; onSettled?: AnyFn }) => {
        const mutation = trpc.chats.restore.useMutation({
          onSuccess: () => opts?.onSettled?.(),
          onError: (err) => opts?.onError?.(err),
        });
        return {
          mutate: async (args?: { chatId: string }) => {
            const context = await opts?.onMutate?.(args);
            if (args?.chatId) {
              mutation.mutate({ id: args.chatId });
            }
            return context;
          },
          isPending: mutation.isPending,
        };
      },
    },
    renameChat: {
      useMutation: (opts?: { onSuccess?: AnyFn; onError?: AnyFn }) => {
        const mutation = trpc.chats.rename.useMutation({
          onSuccess: (data) => opts?.onSuccess?.(data),
          onError: (err) => opts?.onError?.(err),
        });
        return {
          mutate: (args?: { chatId: string; name: string }) => {
            if (args?.chatId && args?.name) {
              mutation.mutate({ id: args.chatId, name: args.name });
            }
          },
          mutateAsync: async (args?: { chatId: string; name: string }) => {
            if (args?.chatId && args?.name) {
              return mutation.mutateAsync({ id: args.chatId, name: args.name });
            }
          },
        };
      },
    },
    renameSubChat: {
      useMutation: (opts?: {
        onSuccess?: (data: unknown, variables: { subChatId: string; name: string }) => void;
        onError?: (error: { data?: { code?: string }; message?: string }) => void;
        onMutate?: AnyFn;
      }) => {
        const mutation = trpc.chats.renameSubChat.useMutation({
          onSuccess: (data, variables) => {
            // Forward variables in the format expected by the wrapper API
            const wrapperVariables = variables
              ? { subChatId: variables.id, name: variables.name }
              : { subChatId: '', name: '' };
            opts?.onSuccess?.(data, wrapperVariables);
          },
          onError: (err) =>
            opts?.onError?.({
              data: err.data ? { code: err.data.code } : undefined,
              message: err.message,
            }),
        });
        return {
          mutate: (
            args?: { subChatId: string; name: string },
            callbacks?: { onSuccess?: AnyFn },
          ) => {
            if (args?.subChatId && args?.name) {
              mutation.mutate(
                { id: args.subChatId, name: args.name },
                { onSuccess: callbacks?.onSuccess },
              );
            }
          },
          mutateAsync: async (args?: { subChatId: string; name: string }) => {
            if (args?.subChatId && args?.name) {
              return mutation.mutateAsync({
                id: args.subChatId,
                name: args.name,
              });
            }
          },
          isPending: mutation.isPending,
        };
      },
    },
    updateSubChatMode: {
      useMutation: (opts?: {
        onSuccess?: (data: SubChatModeResult, variables: SubChatModeVariables) => void;
        onError?: (error: { message?: string }, variables: SubChatModeVariables) => void;
      }) => {
        const mutation = trpc.chats.updateSubChatMode.useMutation({
          // Forward variables in the wrapper's shape: the CAS ack and the revert in useChatMode
          // key off them (decision `sub-chat-mode-ownership`); dropping them disarms both silently.
          onSuccess: (data, variables) =>
            opts?.onSuccess?.(data, { subChatId: variables.id, mode: variables.mode }),
          onError: (err, variables) =>
            opts?.onError?.(
              { message: err.message },
              { subChatId: variables.id, mode: variables.mode },
            ),
        });
        return {
          mutate: (args?: { subChatId: string; mode: 'plan' | 'agent' | 'debug' }) => {
            if (args?.subChatId && args?.mode) {
              mutation.mutate({ id: args.subChatId, mode: args.mode });
            }
          },
          isPending: mutation.isPending,
        };
      },
    },
    // Desktop stubs - not needed for local development
    createAgentPr: {
      useMutation: (opts?: { onSuccess?: AnyFn; onError?: AnyFn }) => ({
        mutate: (_args?: AnyObj, _callbacks?: { onSuccess?: AnyFn }) => {
          // Desktop: PR creation not implemented yet
          opts?.onError?.(new Error('PR creation not available in desktop app'));
        },
        mutateAsync: async (_args?: AnyObj) => {
          throw new Error('PR creation not available in desktop app');
        },
        isPending: false,
      }),
    },
    archiveChatsBatch: {
      useMutation: (opts?: { onSuccess?: AnyFn }) => {
        const mutation = trpc.chats.archiveBatch.useMutation({
          onSuccess: () => opts?.onSuccess?.(),
        });
        return {
          mutate: (args?: { chatIds: string[] }, callbacks?: { onSuccess?: AnyFn }) => {
            if (args?.chatIds) {
              mutation.mutate({ chatIds: args.chatIds }, { onSuccess: callbacks?.onSuccess });
            }
          },
          isPending: mutation.isPending,
        };
      },
    },
  },
  usage: {
    getUserUsage: {
      useQuery: (_args?: AnyObj, _opts?: AnyObj) => ({
        // Desktop: no usage limits
        data: {
          usage: 0,
          limit: Infinity,
          planType: 'desktop' as const,
          nextPaymentAt: null,
        },
        isLoading: false,
      }),
    },
  },
  useUtils: () => {
    const utils = trpc.useUtils();
    return {
      chats: { getSubChatMessages: utils.chats.getSubChatMessages },
      agents: {
        getAgentChats: {
          cancel: async () => utils.chats.list.cancel(),
          getData: () => utils.chats.list.getData({}),
          setData: (keyOrUpdater?: unknown, updater?: unknown) => {
            if (typeof keyOrUpdater === 'function') {
              utils.chats.list.setData(
                {},
                keyOrUpdater as SetDataUpdater<ChatListItem[] | undefined>,
              );
            } else if (updater) {
              utils.chats.list.setData({}, updater as SetDataUpdater<ChatListItem[] | undefined>);
            }
          },
          invalidate: async () => {
            await Promise.all([utils.chats.list.invalidate(), utils.chats.listCounts.invalidate()]);
          },
        },
        getArchivedChats: {
          cancel: async () => utils.chats.listArchived.cancel(),
          getData: () => utils.chats.listArchived.getData(undefined),
          setData: (keyOrUpdater?: unknown, updater?: unknown) => {
            if (typeof keyOrUpdater === 'function') {
              utils.chats.listArchived.setData(
                undefined,
                keyOrUpdater as SetDataUpdater<ChatListItem[] | undefined>,
              );
            } else if (updater) {
              utils.chats.listArchived.setData(
                undefined,
                updater as SetDataUpdater<ChatListItem[] | undefined>,
              );
            }
          },
          invalidate: async () => utils.chats.listArchived.invalidate(),
        },
        getAgentChat: {
          cancel: async () => {},
          getData: (args?: { chatId: string }) => {
            if (!args?.chatId) return null;
            return utils.chats.get.getData({ id: args.chatId });
          },
          setData: (
            args?: { chatId: string },
            updater?: Parameters<typeof utils.chats.get.setData>[1],
          ) => {
            if (args?.chatId && updater) {
              utils.chats.get.setData({ id: args.chatId }, updater);
            }
          },
          invalidate: async (args?: { chatId: string }) => {
            if (args?.chatId) {
              await utils.chats.get.invalidate({ id: args.chatId });
            }
          },
        },
        getPendingPlanApprovals: utils.chats.getPendingPlanApprovals,
        getSubChats: {
          invalidate: async () => {},
          setData: () => {},
        },
      },
      github: {
        getSlashCommandContent: {
          fetch: async (_args?: AnyObj) => ({ content: '' }),
        },
        searchFiles: {
          cancel: async () => utils.files.search.cancel(),
        },
      },
      user: {
        getProfile: {
          invalidate: async () => {},
        },
      },
      stripe: {
        getCheckoutSession: {
          invalidate: async () => {},
        },
        getUserBalance: {
          invalidate: async () => {},
        },
      },
    };
  },
  // Stubs for features not needed in desktop
  teams: {
    getUserTeams: { useQuery: () => ({ data: [], isLoading: false }) },
    getTeam: { useQuery: () => ({ data: null, isLoading: false }) },
    updateTeam: {
      useMutation: () => ({
        mutate: () => {},
        mutateAsync: async () => ({}),
        isPending: false,
      }),
    },
  },
  repositorySandboxes: {
    getRepositoriesWithStatus: {
      useQuery: () => ({
        data: { repositories: [] },
        isLoading: false,
        refetch: async () => ({ data: { repositories: [] } }),
      }),
    },
  },
  stripe: {
    getUserBalance: { useQuery: () => ({ data: 0, isLoading: false }) },
    createCheckoutSession: {
      useMutation: () => ({
        mutate: () => {},
        mutateAsync: async () => ({ url: '' }),
        isPending: false,
      }),
    },
    createBillingPortalSession: {
      useMutation: () => ({
        mutate: () => {},
        mutateAsync: async () => ({ url: '' }),
        isPending: false,
      }),
    },
  },
  user: {
    getProfile: { useQuery: () => ({ data: null, isLoading: false }) },
    updateProfile: {
      useMutation: () => ({
        mutate: () => {},
        mutateAsync: async () => ({}),
        isPending: false,
      }),
    },
  },
  github: {
    getBranches: {
      useQuery: () => ({
        data: { branches: [] },
        isLoading: false,
        refetch: async () => ({ data: { branches: [] } }),
      }),
    },
    searchFiles: {
      useQuery: (
        args?: {
          teamId?: string;
          repository?: string;
          query?: string;
          limit?: number;
          sandboxId?: string;
          branch?: string;
          projectPath?: string;
        },
        opts?: AnyObj,
      ) => {
        // Use real tRPC to search local files
        // Extract and validate options with proper types
        const staleTime = typeof opts?.staleTime === 'number' ? opts.staleTime : 5000;
        const refetchOnWindowFocus =
          typeof opts?.refetchOnWindowFocus === 'boolean' ? opts.refetchOnWindowFocus : false;
        const enabled = !!args?.projectPath && opts?.enabled !== false;
        const result = trpc.files.search.useQuery(
          {
            projectPath: args?.projectPath || '',
            query: args?.query || '',
            limit: args?.limit || 50,
          },
          {
            enabled,
            staleTime,
            refetchOnWindowFocus,
            // Omit placeholderData - it's not essential and causes type issues with AnyObj
            // If needed, callers should use keepPreviousData directly from @tanstack/react-query
          },
        );
        return {
          data: result.data ?? [],
          isLoading: result.isLoading,
          isFetching: result.isFetching,
          error: result.error,
        };
      },
    },
    getSlashCommands: { useQuery: () => ({ data: [], isLoading: false }) },
    getUserInstallations: { useQuery: () => ({ data: [], isLoading: false }) },
    getGithubConnection: {
      useQuery: () => ({ data: { isConnected: false }, isLoading: false }),
    },
    connectGithub: {
      useMutation: () => ({
        mutate: () => {},
        mutateAsync: async () => ({}),
        isPending: false,
      }),
    },
    disconnectGithub: {
      useMutation: () => ({
        mutate: () => {},
        mutateAsync: async () => ({}),
        isPending: false,
      }),
    },
    createBranch: {
      useMutation: () => ({
        mutate: () => {},
        mutateAsync: async () => ({ branch: '' }),
        isPending: false,
      }),
    },
  },
  claudeCode: {
    getClaudeCodeConnection: {
      useQuery: () => ({ data: { isConnected: true }, isLoading: false }),
    },
    connectClaudeCode: {
      useMutation: () => ({
        mutate: () => {},
        mutateAsync: async () => ({}),
        isPending: false,
      }),
    },
    disconnectClaudeCode: {
      useMutation: () => ({
        mutate: () => {},
        mutateAsync: async () => ({}),
        isPending: false,
      }),
    },
  },
  agentInvites: {
    getOrCreateInviteCode: {
      useQuery: () => ({
        data: { maxUses: 0, usesCount: 0 },
        isLoading: false,
      }),
    },
  },
};
