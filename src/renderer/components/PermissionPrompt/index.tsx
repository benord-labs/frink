/**
 * PermissionPrompt - Compact banner for permission requests.
 *
 * View-switch, in order:
 * - request.flowConsent set → FlowConsentView (per-flow agent-run consent, 3 outcomes)
 * - request.prompt undefined → SimpleApprovalView (frink-internal move-chat / MCP, 2 buttons)
 * - request.prompt defined   → FourButtonView (v2 path: Allow this time / Always allow <rule> in project|machine / Deny)
 */

import { Button } from '@benord-labs/frink-primitives';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { memo, useCallback } from 'react';
import type { ApprovalDecision, PermissionRequest } from '../../hooks/usePermissionPrompts';
import { getPaneColor, getPanePermissionChrome } from '../../lib/pane-colors';
import { cn } from '../../lib/utils';
import { FlowConsentView } from './FlowConsentView';
import { FourButtonView } from './FourButtonView';
import { SimpleApprovalView } from './SimpleApprovalView';

type QueueInfo = {
  /** 1-indexed position of the currently shown request */
  current: number;
  /** Total pending requests */
  total: number;
};

type PermissionPromptProps = {
  request: PermissionRequest;
  onApprove: (requestId: string, decision?: ApprovalDecision) => void;
  onDeny: (requestId: string) => void;
  /** 1-indexed pane number (only shown when split view has >= 2 panes) */
  paneNumber?: number;
  /** Queue position info (shown when multiple requests are pending) */
  queueInfo?: QueueInfo;
  /** Callback to cycle to the next queued request */
  onNext?: () => void;
  /** Callback to cycle to the previous queued request */
  onPrevious?: () => void;
  className?: string;
};

/** Shared header showing pane badge and queue counter */
const PermissionHeader = memo(function PermissionHeader({
  paneNumber,
  paneBadgeClassName,
  queueInfo,
  onNext,
  onPrevious,
}: {
  paneNumber?: number;
  paneBadgeClassName?: string;
  queueInfo?: QueueInfo;
  onNext?: () => void;
  onPrevious?: () => void;
}) {
  const showPane = paneNumber !== undefined && paneNumber > 0;
  const showQueue = queueInfo !== undefined && queueInfo.total > 1;
  if (!showPane && !showQueue) return null;

  return (
    <div className="flex items-center justify-between gap-2 mb-0.5">
      {showPane ? (
        <span
          className={
            paneBadgeClassName ??
            'inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-primary bg-primary/10 px-1.5 py-0.5 rounded'
          }
        >
          Pane {paneNumber}
        </span>
      ) : (
        <span />
      )}
      {showQueue && (
        <div className="flex items-center gap-0.5">
          {onPrevious && queueInfo.total > 1 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={onPrevious}
              aria-label="Show previous permission request"
              iconOnly
            >
              <ChevronLeft className="h-3 w-3" />
            </Button>
          )}
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {queueInfo.current} of {queueInfo.total}
          </span>
          {onNext && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={onNext}
              aria-label="Show next permission request"
              iconOnly
            >
              <ChevronRight className="h-3 w-3" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
});

export const PermissionPrompt = memo(function PermissionPrompt({
  request,
  onApprove,
  onDeny,
  paneNumber,
  queueInfo,
  onNext,
  onPrevious,
  className,
}: PermissionPromptProps) {
  const paneIdx = paneNumber !== undefined && paneNumber > 0 ? paneNumber - 1 : undefined;
  const paneChrome = paneIdx !== undefined ? getPanePermissionChrome(paneIdx) : null;
  const primaryCtaClassName = paneChrome?.primaryCtaClassName;
  const paneLinkAccentClass =
    paneIdx !== undefined ? getPaneColor(paneIdx).badgeText : 'text-primary';

  const handleDeny = useCallback(() => onDeny(request.requestId), [onDeny, request.requestId]);
  const handleSimpleApprove = useCallback(
    () => onApprove(request.requestId),
    [onApprove, request.requestId],
  );
  const handleFourButtonApprove = useCallback(
    (decision: ApprovalDecision) => onApprove(request.requestId, decision),
    [onApprove, request.requestId],
  );
  const handleFlowGrantAlways = useCallback(
    () => onApprove(request.requestId, { flowGrant: true }),
    [onApprove, request.requestId],
  );

  return (
    <div
      className={cn(
        'flex flex-col gap-2 px-3 py-2.5',
        'glass-float border border-border rounded-md',
        'animate-in slide-in-from-top-2 duration-150',
        className,
      )}
    >
      <PermissionHeader
        paneNumber={paneNumber}
        paneBadgeClassName={paneChrome?.badgeClassName}
        queueInfo={queueInfo}
        onNext={onNext}
        onPrevious={onPrevious}
      />
      {request.flowConsent ? (
        <FlowConsentView
          flowConsent={request.flowConsent}
          onAllowOnce={handleSimpleApprove}
          onAllowAlways={handleFlowGrantAlways}
          onDeny={handleDeny}
          primaryCtaClassName={primaryCtaClassName}
        />
      ) : request.prompt === undefined ? (
        <SimpleApprovalView
          request={request}
          onApprove={handleSimpleApprove}
          onDeny={handleDeny}
          primaryCtaClassName={primaryCtaClassName}
        />
      ) : (
        <FourButtonView
          request={{ ...request, prompt: request.prompt }}
          onApprove={handleFourButtonApprove}
          onDeny={handleDeny}
          primaryCtaClassName={primaryCtaClassName}
          paneLinkAccentClass={paneLinkAccentClass}
        />
      )}
    </div>
  );
});

export { usePermissionPrompts } from '../../hooks/usePermissionPrompts';
