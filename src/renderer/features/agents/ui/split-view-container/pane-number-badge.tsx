import { getPaneColor } from '../../../../lib/pane-colors';
import { cn } from '../../../../lib/utils';

/**
 * Compact digit-only pill for split UI (pane headers, sidebar, editor tabs, drag overlay).
 */
export function CompactPaneDigitBadge({
  paneIndex,
  paneNumber,
  className,
}: {
  paneIndex: number;
  paneNumber: number;
  className?: string;
}) {
  const color = getPaneColor(paneIndex);
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded text-[10px] font-semibold border opacity-80 shrink-0',
        color.badgeBg,
        color.badgeText,
        color.badgeBorder,
        className,
      )}
      title={`Displayed in pane ${paneNumber}`}
    >
      <span className="sr-only">Pane </span>
      {paneNumber}
    </span>
  );
}
