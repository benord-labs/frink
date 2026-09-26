import type { ReactElement } from 'react';
import {
  FLOW_LIST_SECTION_LABELS,
  type FlowListSectionId,
} from '../../../../lib/flows/flow-list-sections';
import { cn } from '../../../../lib/utils';
import { type FlowListItem, FlowListRow } from '../FlowListRow';

type FlowListTableProps<T extends FlowListItem> = {
  sections: { id: FlowListSectionId; flows: T[] }[];
  draftIds: ReadonlySet<string>;
  displayStatusOf: (flow: T) => string | null;
  onOpen: (id: string) => void;
  onDelete: (flow: T) => void;
};

/** Flows as a calm, status-led list: sections of two-line rows, name over description. */
export function FlowListTable<T extends FlowListItem>({
  sections,
  draftIds,
  displayStatusOf,
  onOpen,
  onDelete,
}: FlowListTableProps<T>): ReactElement {
  // A lone "Enabled" heading would only repeat the page title's count, so it stays for readers only.
  const lone = sections.length === 1 && sections[0]?.id === 'flows';
  return (
    <div data-flow-list className="flex flex-col gap-8">
      {sections.map((section) => (
        <section key={section.id} aria-labelledby={`flows-section-${section.id}`}>
          <h2
            id={`flows-section-${section.id}`}
            className={cn(
              'flex h-8 items-center gap-2 pl-2.5 text-base font-semibold text-foreground',
              lone && 'sr-only',
            )}
          >
            {FLOW_LIST_SECTION_LABELS[section.id]}
            <span className="font-normal tabular-nums text-muted-foreground">
              {section.flows.length}
            </span>
          </h2>
          <ul className={lone ? undefined : 'mt-1'}>
            {section.flows.map((flow) => (
              <FlowListRow
                key={flow.id}
                flow={flow}
                sectionId={section.id}
                displayStatus={displayStatusOf(flow)}
                hasDraft={draftIds.has(flow.id)}
                onOpen={onOpen}
                onDelete={onDelete}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
