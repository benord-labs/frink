import { useAtomValue } from 'jotai';
import { memo } from 'react';
import { terminalDisplayModeAtom } from './atoms';
import { TerminalBottomPanel } from './terminal-bottom-panel';

type TerminalBottomPanelGateProps = {
  chatId: string;
  cwd: string;
  workspaceId: string;
  tabId?: string;
  initialCommands?: string[];
  autoCreate?: boolean;
  hideModeSwitcher?: boolean;
  /** Split-chat: false when this chat column is inactive. Defaults to true. */
  isPaneActive?: boolean;
};

/**
 * Thin gate that isolates the `terminalDisplayModeAtom` subscription.
 * Renders `TerminalBottomPanel` only when mode is 'bottom', preventing
 * the parent (ChatView) from re-rendering on every mode toggle.
 */
export const TerminalBottomPanelGate = memo(function TerminalBottomPanelGate(
  props: TerminalBottomPanelGateProps,
) {
  const displayMode = useAtomValue(terminalDisplayModeAtom);
  if (displayMode !== 'bottom') return null;
  return <TerminalBottomPanel {...props} />;
});
