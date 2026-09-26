import { getAutoModeUnavailableReason } from '../../lib/agent-chat/auto-mode-availability';

export type AutoModeContext = {
  accountResolved: boolean;
  account: { type: string; isAuthenticated: boolean } | null | undefined;
  selectedModelId: string;
};

export function useAutoModeAvailability({
  accountResolved,
  account,
  selectedModelId,
}: AutoModeContext) {
  const unavailableReason = getAutoModeUnavailableReason({
    accountResolved,
    isAuthenticated: account?.isAuthenticated,
    accountType: account?.type,
    selectedModelId,
  });
  // Auto reviews tool requests in plan mode too — the planning phase and, on acceptance, the
  // implementation phase. So there is no plan-only caveat to surface here.
  return {
    available: unavailableReason.length === 0,
    unavailableReason,
  };
}
