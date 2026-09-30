import { atom, useAtom } from 'jotai';
import { trpc } from '../trpc';

type AccountPick = { projectId: string | null; accountId: string };
type RefetchInterval = (query: {
  state: { data?: { isAuthenticated: boolean } | null };
}) => number | false;

/** The login picked in the new-chat composer, kept only for the chat being drafted. */
const newChatAccountPickAtom = atom<AccountPick | null>(null);

/**
 * The login a new chat starts on: the composer's pick for this project, else the project's
 * login, else the workspace default. Picking never changes those defaults; Settings does.
 */
export function useNewChatAccount(
  projectId?: string,
  refetchInterval?: RefetchInterval,
  enabled = true,
) {
  const [pick, setPick] = useAtom(newChatAccountPickAtom);
  const resolved = trpc.claudeCode.getResolvedAccount.useQuery(
    { projectId },
    { staleTime: 30000, refetchInterval, enabled },
  );
  const { data: accounts = [] } = trpc.claudeCode.listAccounts.useQuery(undefined, {
    staleTime: 30000,
  });
  const scope = projectId ?? null;
  const picked =
    pick?.projectId === scope ? accounts.find((a) => a.id === pick.accountId) : undefined;
  return {
    account: picked ? { ...picked, isProjectOverride: false } : (resolved.data ?? null),
    accountResolved: resolved.isSuccess,
    accounts,
    pickedAccountId: picked?.id,
    pickAccount: (accountId: string) => setPick({ projectId: scope, accountId }),
    clearPick: () => setPick(null),
  };
}
