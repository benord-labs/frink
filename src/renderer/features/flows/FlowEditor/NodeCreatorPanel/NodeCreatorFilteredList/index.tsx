import { type MouseEvent, type ReactElement, useEffect, useRef } from 'react';
import type { FlowBlockType } from '../../../../../../shared/types/flow';
import { BRAND_TILE_RIM_STYLE, ProviderIcon } from '../../../../../components/ProviderIcon';
import { cn } from '../../../../../lib/utils';
import { FLOW_BLOCK_DESCRIPTIONS, FLOW_BLOCK_LABELS } from '../../constants';
import { FlowBlockIcon } from '../../FlowBlockIcon';
import { blockIconSurfaceClass } from '../../FlowCanvas/flowStepNodeStyles';
import { NODE_CREATOR_LISTBOX_ID, NODE_CREATOR_OPTION_ID_PREFIX } from '../constants';
import {
  NODE_CREATOR_LIST_SCROLL_CLASS,
  NODE_CREATOR_SECTION_HEADER_CLASS,
} from '../node-creator-chrome';
import type { NodeCreatorCategory } from '../nodeCreatorCategories';

type PluginMetaEntry = { pluginId: string; pluginLabel: string };
type PluginMetaMap = ReadonlyMap<string, PluginMetaEntry> | undefined;
type PluginRun = PluginMetaEntry & { key: string; types: string[] };

type NodeCreatorFilteredListProps = {
  filtered: NodeCreatorCategory[];
  blockTypeIndexMap: ReadonlyMap<string, number>;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onPick: (blockType: string) => void;
  customLabels?: ReadonlyMap<string, string>;
  customDescriptions?: ReadonlyMap<string, string>;
  customBlockIcons?: ReadonlyMap<string, string>;
  /** Owning plugin per block type, used to preserve integration grouping. */
  pluginMeta?: ReadonlyMap<string, PluginMetaEntry>;
};

type RowCommon = {
  blockTypeIndexMap: ReadonlyMap<string, number>;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onPick: (blockType: string) => void;
  customLabels: ReadonlyMap<string, string> | undefined;
  customDescriptions: ReadonlyMap<string, string> | undefined;
  customBlockIcons: ReadonlyMap<string, string> | undefined;
  itemRefs: { current: Map<number, HTMLLIElement> };
};

type RowProps = { t: string; common: RowCommon };
type GroupProps = { cat: NodeCreatorCategory; common: RowCommon; pluginMeta: PluginMetaMap };

const UNKNOWN_PLUGIN: PluginMetaEntry = { pluginId: 'unknown', pluginLabel: 'Integrations' };
const ROW_GROUP_CLASS =
  'overflow-hidden rounded-lg border border-border/50 bg-background/35 divide-y divide-border/40';
const ROW_BASE = cn(
  'group flex min-h-14 w-full cursor-pointer items-center gap-3 px-3 py-2 text-left outline-none',
  'transition-colors duration-150 motion-reduce:transition-none',
);
const ROW_ACTIVE = 'bg-primary/10 text-foreground ring-1 ring-inset ring-primary/30';

/** Keep consecutive plugin runs so render order and keyboard order cannot diverge. */
function chunkByPlugin(types: string[], pluginMeta: PluginMetaMap): PluginRun[] {
  const runs: PluginRun[] = [];
  for (const t of types) {
    const meta = pluginMeta?.get(t) ?? UNKNOWN_PLUGIN;
    const open = runs.at(-1);
    if (open && open.pluginId === meta.pluginId) open.types.push(t);
    else runs.push({ ...meta, key: `${meta.pluginId}:${t}`, types: [t] });
  }
  return runs;
}

function toolCountLabel(count: number): string {
  return count === 1 ? '1 tool' : `${count} tools`;
}

function labelFor(t: string, custom: ReadonlyMap<string, string> | undefined): string {
  return FLOW_BLOCK_LABELS[t as FlowBlockType] ?? custom?.get(t) ?? t;
}

function descriptionFor(t: string, custom: ReadonlyMap<string, string> | undefined): string {
  return FLOW_BLOCK_DESCRIPTIONS[t as FlowBlockType] ?? custom?.get(t) ?? '';
}

function bindOption(t: string, common: RowCommon) {
  const idx = common.blockTypeIndexMap.get(t);
  const isActive = idx !== undefined && idx === common.activeIndex;

  return {
    id:
      idx !== undefined
        ? `${NODE_CREATOR_OPTION_ID_PREFIX}${idx}`
        : `${NODE_CREATOR_OPTION_ID_PREFIX}unknown-${t}`,
    ref: (element: HTMLLIElement | null) => {
      if (idx === undefined) return;
      if (element) common.itemRefs.current.set(idx, element);
      else common.itemRefs.current.delete(idx);
    },
    role: 'option' as const,
    'aria-selected': isActive,
    tabIndex: -1,
    className: cn(ROW_BASE, isActive ? ROW_ACTIVE : 'hover:bg-muted/60'),
    onClick: () => common.onPick(t),
    onMouseDown: (event: MouseEvent<HTMLLIElement>) => {
      event.preventDefault();
    },
    onMouseEnter: () => {
      if (idx !== undefined) common.onActiveIndexChange(idx);
    },
  };
}

function CatalogRow({ t, common }: RowProps): ReactElement {
  const labelText = labelFor(t, common.customLabels);

  return (
    <li {...bindOption(t, common)}>
      <span
        className={cn(
          'relative isolate flex size-8 shrink-0 items-center justify-center rounded-lg',
          blockIconSurfaceClass(t),
        )}
      >
        <FlowBlockIcon
          type={t as FlowBlockType}
          customBlockIcon={common.customBlockIcons?.get(t)}
          className="size-4 shrink-0 [&>svg]:block"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{labelText}</span>
        <span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-muted-foreground">
          {descriptionFor(t, common.customDescriptions)}
        </span>
      </span>
    </li>
  );
}

function IntegrationGroups({ cat, common, pluginMeta }: GroupProps): ReactElement {
  return (
    <div role="presentation" className="space-y-3 pt-1">
      {chunkByPlugin(cat.types, pluginMeta).map((run) => {
        return (
          <div key={run.key} role="presentation">
            <div
              role="presentation"
              aria-hidden
              className="flex min-w-0 items-center gap-2.5 px-2 pb-2"
            >
              <span
                className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md"
                style={BRAND_TILE_RIM_STYLE}
              >
                <ProviderIcon providerId={run.pluginId} appearance="tile" className="size-4" />
              </span>
              <span className="min-w-0 truncate text-xs font-semibold text-foreground">
                {run.pluginLabel}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {toolCountLabel(run.types.length)}
              </span>
            </div>
            <ul role="group" aria-label={run.pluginLabel} className={ROW_GROUP_CLASS}>
              {run.types.map((t) => (
                <CatalogRow key={t} t={t} common={common} />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export function NodeCreatorFilteredList(props: NodeCreatorFilteredListProps): ReactElement {
  const { filtered, activeIndex, pluginMeta } = props;
  const itemRefs = useRef<Map<number, HTMLLIElement>>(new Map());

  useEffect(() => {
    itemRefs.current.get(activeIndex)?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, [activeIndex]);

  const common: RowCommon = {
    blockTypeIndexMap: props.blockTypeIndexMap,
    activeIndex,
    onActiveIndexChange: props.onActiveIndexChange,
    onPick: props.onPick,
    customLabels: props.customLabels,
    customDescriptions: props.customDescriptions,
    customBlockIcons: props.customBlockIcons,
    itemRefs,
  };

  return (
    <div
      id={NODE_CREATOR_LISTBOX_ID}
      role="listbox"
      aria-label="Available flow steps"
      className={NODE_CREATOR_LIST_SCROLL_CLASS}
    >
      {filtered.length === 0 ? (
        <div role="presentation" className="flex min-h-28 items-center justify-center">
          <p className="text-sm text-muted-foreground">No steps match your search.</p>
        </div>
      ) : (
        filtered.map((cat) => {
          return (
            <div key={cat.id} role="group" aria-label={cat.label}>
              <div aria-hidden className={NODE_CREATOR_SECTION_HEADER_CLASS}>
                <span className="min-w-0 truncate text-xs font-semibold text-foreground">
                  {cat.label}
                </span>
                <span className="ml-2 shrink-0 text-xs tabular-nums text-muted-foreground">
                  {cat.types.length}
                </span>
              </div>
              {cat.id === 'integrations' ? (
                <IntegrationGroups cat={cat} common={common} pluginMeta={pluginMeta} />
              ) : (
                <ul role="presentation" className={cn(ROW_GROUP_CLASS, 'mt-1')}>
                  {cat.types.map((t) => (
                    <CatalogRow key={t} t={t} common={common} />
                  ))}
                </ul>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
