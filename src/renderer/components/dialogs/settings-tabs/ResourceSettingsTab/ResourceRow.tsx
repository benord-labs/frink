/**
 * One skill or agent in the directory row language. Callbacks take the item so
 * the parent can pass stable references.
 */
import { cn } from '@benord-labs/frink-primitives';
import { Copy, FolderOpen } from 'lucide-react';
import { memo, type ReactElement, type ReactNode } from 'react';
import {
  RowDetails,
  SettingsListRow,
  SoftButton,
  WARNING_TEXT_CLASS,
} from '@/components/settings/SettingsList';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { SOURCE_LABELS } from '@/components/ui/ide-source-badge';
import { getFileManagerName } from '@/lib/utils/platform';
import type { ResourceInfo } from '@/types/resource-info';

type Props = {
  item: ResourceInfo;
  /** How to call this item from chat, shown when the row is open. */
  usage?: (name: string) => ReactNode;
  isExpanded: boolean;
  onToggle: (path: string) => void;
  onOpenInFinder: (path: string) => void;
  /** Omitted when the resource never crosses tools: no gap pill, sharing note or Copy across. */
  onCopyAcross?: (item: ResourceInfo) => void;
};

/** Neither built in nor readable everywhere: the one state on these rows the user can act on. */
function hasGap(item: ResourceInfo): boolean {
  return !item.builtIn && !item.followsYou;
}

function gapLabel(item: ResourceInfo): string {
  if (!item.readableBy?.length) return 'Not shared';
  return `Only in ${item.readableBy.map((tool) => SOURCE_LABELS[tool] ?? tool).join(', ')}`;
}

/** Plain text in the open row, so it never depends on hover. */
function sharingNote(item: ResourceInfo): string {
  if (item.builtIn) return 'Comes with Frink and stays up to date.';
  if (item.followsYou) return 'Every AI tool you use can read it.';
  return item.readableBy?.length
    ? "Your other AI tools can't read it yet."
    : "Your AI tools can't read it yet.";
}

/** Only the exceptions get a pill; a synced row is the normal case and stays quiet. */
function RowPill({ item, shares }: { item: ResourceInfo; shares: boolean }) {
  if (!item.builtIn && !(shares && hasGap(item))) return null;
  return (
    <span
      className={cn(
        'max-w-full truncate rounded-md px-1.5 py-0.5 text-[11px]',
        item.builtIn
          ? 'border border-hairline text-muted-fg'
          : cn('bg-[hsl(var(--status-warning)/0.14)]', WARNING_TEXT_CLASS),
      )}
    >
      {item.builtIn ? 'Built-in' : gapLabel(item)}
    </span>
  );
}

export const ResourceRow = memo(function ResourceRow({
  item,
  usage,
  isExpanded,
  onToggle,
  onOpenInFinder,
  onCopyAcross,
}: Props): ReactElement {
  const fileManager = getFileManagerName();
  const paths = item.sources?.length ? item.sources.map((s) => s.path) : [item.path];
  const copyAcross = onCopyAcross && hasGap(item) ? () => onCopyAcross(item) : null;

  return (
    <SettingsListRow
      id={item.path}
      name={item.name}
      description={item.description || 'No description'}
      descriptionClassName={item.description ? undefined : 'text-dim'}
      status={<RowPill item={item} shares={Boolean(onCopyAcross)} />}
      expanded={isExpanded}
      onToggle={() => onToggle(item.path)}
      menu={
        <>
          <DropdownMenuItem onClick={() => onOpenInFinder(item.path)}>
            <FolderOpen className="mr-2 size-3.5" />
            {`Open in ${fileManager}`}
          </DropdownMenuItem>
          {copyAcross ? (
            <DropdownMenuItem onClick={copyAcross}>
              <Copy className="mr-2 size-3.5" />
              Copy across…
            </DropdownMenuItem>
          ) : null}
        </>
      }
      details={
        <>
          <RowDetails
            items={[
              usage ? { label: 'How to use', value: usage(item.name) } : null,
              onCopyAcross ? { label: 'Other AI tools', value: sharingNote(item) } : null,
              {
                label: 'Location',
                value: (
                  <ul className="space-y-1">
                    {paths.map((path) => (
                      <li key={path}>
                        <button
                          type="button"
                          onClick={() => onOpenInFinder(path)}
                          aria-label={`Open ${path} in ${fileManager}`}
                          className="cursor-pointer break-all text-left font-mono text-muted-fg text-xs underline-offset-2 hover:text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {path}
                        </button>
                      </li>
                    ))}
                  </ul>
                ),
              },
            ]}
          />
          <div className="flex flex-wrap gap-2">
            <SoftButton onClick={() => onOpenInFinder(item.path)}>
              {`Open in ${fileManager}`}
            </SoftButton>
            {copyAcross ? <SoftButton onClick={copyAcross}>Copy across…</SoftButton> : null}
          </div>
        </>
      }
    />
  );
});
