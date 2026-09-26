import { Button } from '@benord-labs/frink-primitives';
import { memo } from 'react';
import type { PermissionRequest } from '../../../hooks/usePermissionPrompts';
import { cn } from '../../../lib/utils';

type SimpleApprovalViewProps = {
  request: PermissionRequest;
  onApprove: () => void;
  onDeny: () => void;
  primaryCtaClassName?: string;
};

/**
 * Renders the 2-button view used by the one frink-internal flow that responds
 * with a boolean only: `agent:request-move-chat`. It is NOT a v2 permission
 * path; it preserves its bespoke IPC channel. All MCP approvals now ride the
 * v2 dispatcher and carry a `prompt` payload, so they render FourButtonView.
 *
 * The view-switch in `PermissionPrompt/index.tsx` routes here when
 * `request.prompt === undefined`.
 */
export const SimpleApprovalView = memo(function SimpleApprovalView({
  request,
  onApprove,
  onDeny,
  primaryCtaClassName,
}: SimpleApprovalViewProps) {
  const displayPath = request.path.length > 100 ? `${request.path.slice(0, 100)}...` : request.path;

  return (
    <>
      <div className="flex items-start gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium py-0.5 shrink-0">
          Project
        </span>
        <span className="text-xs text-foreground leading-relaxed">
          Switch to &quot;{displayPath}&quot; and continue?
        </span>
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs" onClick={onDeny}>
          Deny
        </Button>
        <Button
          variant="primary"
          size="sm"
          className={cn('h-7 px-2.5 text-xs', primaryCtaClassName)}
          onClick={onApprove}
        >
          Approve
        </Button>
      </div>
    </>
  );
});
