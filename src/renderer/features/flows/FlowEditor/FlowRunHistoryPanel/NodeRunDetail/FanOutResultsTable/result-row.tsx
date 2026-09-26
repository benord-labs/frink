import { Button } from '@benord-labs/frink-primitives';
import { useAtomValue, useSetAtom } from 'jotai';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { flowEditorDirtyAtom, navigateToAgentChatAtom } from '../../../../../../lib/atoms';
import { cn } from '../../../../../../lib/utils';
import { DirtyNavAlertDialog } from '../../BatchReportPanel/DirtyNavAlertDialog';
import type { FanOutLaneStatus } from '../derive-result-status';

const STATUS_BADGE: Record<FanOutLaneStatus, { label: string; className: string }> = {
  passed: {
    label: 'Pass',
    className: 'bg-[hsl(var(--status-online)/0.15)] text-[hsl(var(--status-online-text))]',
  },
  failed: { label: 'Fail', className: 'bg-destructive/15 text-destructive' },
  skipped: { label: 'Skip', className: 'bg-muted text-muted-foreground' },
  unknown: { label: '?', className: 'bg-muted/60 text-muted-foreground/60' },
};

const MAX_SUMMARY_LEN = 120;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

type Props = {
  laneIndex: number;
  branchRootNodeId: string;
  branchLabel: string;
  status: FanOutLaneStatus;
  summary?: string;
  errorMessage?: string;
  chatId?: string;
};

export function ResultRow({
  laneIndex,
  branchRootNodeId,
  branchLabel,
  status,
  summary,
  errorMessage,
  chatId,
}: Props) {
  const isDirty = useAtomValue(flowEditorDirtyAtom);
  const navigateToChat = useSetAtom(navigateToAgentChatAtom);
  const [showDirtyDialog, setShowDirtyDialog] = useState(false);
  const [pendingChatId, setPendingChatId] = useState<string | null>(null);

  const badge = STATUS_BADGE[status];

  const handleOpenChat = (id: string) => {
    if (isDirty) {
      setPendingChatId(id);
      setShowDirtyDialog(true);
    } else {
      navigateToChat(id);
    }
  };

  const handleConfirmNav = () => {
    if (pendingChatId) {
      navigateToChat(pendingChatId);
    }
    setShowDirtyDialog(false);
    setPendingChatId(null);
  };

  return (
    <>
      <tr
        className={cn(
          'border-b border-border/30 last:border-0',
          status === 'failed' ? 'bg-destructive/4' : '',
        )}
      >
        <td className="py-1 pl-1 pr-2 text-[10px] tabular-nums text-muted-foreground/60 w-6 shrink-0">
          {laneIndex + 1}
        </td>
        <td className="py-1 pr-2 w-12 shrink-0">
          <span
            className={cn(
              'inline-block rounded px-1 py-px text-[9px] font-medium leading-tight',
              badge.className,
            )}
          >
            {badge.label}
          </span>
        </td>
        <td className="py-1 pr-2 text-[10px] text-foreground/80 wrap-break-word min-w-0">
          <span className="mr-1 text-muted-foreground/60" title={branchRootNodeId}>
            {truncate(branchLabel, 24)}
          </span>
          {status === 'failed' && errorMessage ? (
            <span className="text-destructive/80">{truncate(errorMessage, MAX_SUMMARY_LEN)}</span>
          ) : summary ? (
            truncate(summary, MAX_SUMMARY_LEN)
          ) : (
            <span className="text-muted-foreground/40 italic">—</span>
          )}
        </td>
        <td className="py-1 w-16 shrink-0 text-right">
          {chatId ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-5 px-1 text-[10px] gap-0.5"
              onClick={() => handleOpenChat(chatId)}
              title="Open chat"
            >
              <ExternalLink className="h-2.5 w-2.5" aria-hidden />
              Chat
            </Button>
          ) : null}
        </td>
      </tr>

      <DirtyNavAlertDialog
        showDialog={showDirtyDialog}
        onConfirm={handleConfirmNav}
        onCancel={() => {
          setShowDirtyDialog(false);
          setPendingChatId(null);
        }}
      />
    </>
  );
}
