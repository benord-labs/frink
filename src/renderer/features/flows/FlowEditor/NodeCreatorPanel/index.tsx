/* eslint-disable max-lines, max-lines-per-function */
/** Centered, searchable catalog for adding a flow block. */

import { Button, Input } from '@benord-labs/frink-primitives';
import { Loader2, Plus, Search, Trash2, X } from 'lucide-react';
import {
  Fragment,
  type KeyboardEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import type { FlowBlockType } from '../../../../../shared/types/flow';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../../components/ui/alert-dialog';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../../../components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../../components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../../components/ui/tabs';
import { buildCustomNodeCategories } from '../../../../lib/flows/node-creator/categories';
import { trpc } from '../../../../lib/trpc';
import {
  NODE_CREATOR_ALL_TAB_ID,
  NODE_CREATOR_LISTBOX_ID,
  NODE_CREATOR_OPTION_ID_PREFIX,
  NODE_CREATOR_SHEET_DESCRIPTION,
} from './constants';
import { NodeCreatorFilteredList } from './NodeCreatorFilteredList';
import {
  NODE_CREATOR_FOOTER_CLASS,
  NODE_CREATOR_HEADER_CLASS,
  NODE_CREATOR_PANEL_BODY_CLASS,
  NODE_CREATOR_SEARCH_INPUT_CLASS,
  NODE_CREATOR_SEARCH_WRAP_CLASS,
  NODE_CREATOR_SHEET_SURFACE_CLASS,
  NODE_CREATOR_TAB_CLASS,
  NODE_CREATOR_TAB_RAIL_CLASS,
  NODE_CREATOR_TABS_CONTENT_CLASS,
  NODE_CREATOR_TABS_LIST_CLASS,
} from './node-creator-chrome';
import { NODE_CREATOR_CATEGORIES } from './nodeCreatorCategories';
import { filterNodeCreatorCategories } from './nodeCreatorUtils';

import type { NodeCreatorMode } from '../../../../lib/flows/node-creator/pick';

export type { NodeCreatorMode };

type NodeCreatorPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: NodeCreatorMode | null;
  allowedTypes: FlowBlockType[];
  onPick: (blockType: string) => void;
};

type NodeCreatorTab = { id: string; label: string; count: number };

function resultCountLabel(count: number): string {
  return count === 1 ? '1 step' : `${count} steps`;
}

export function NodeCreatorPanel({
  open,
  onOpenChange,
  mode,
  allowedTypes,
  onPick,
}: NodeCreatorPanelProps): ReactElement {
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState(NODE_CREATOR_ALL_TAB_ID);
  const [activeIndex, setActiveIndex] = useState(0);
  const [deleteTargetName, setDeleteTargetName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const allowed = useMemo(() => new Set<string>(allowedTypes), [allowedTypes]);
  const utils = trpc.useUtils();

  const { data: customNodes } = trpc.customNodes.list.useQuery(undefined, {
    staleTime: 30_000,
  });

  const deleteMutation = trpc.customNodes.delete.useMutation({
    onSuccess: () => {
      void utils.customNodes.list.invalidate();
    },
    onError: (error) => {
      toast.error(error.message || 'Could not remove custom node');
    },
  });

  const {
    customCategory,
    integrationsCategory,
    customLabels,
    customDescriptions,
    customBlockIcons,
    pluginMeta,
  } = useMemo(() => buildCustomNodeCategories(customNodes), [customNodes]);

  const allCategories = useMemo(() => {
    const categories = [...NODE_CREATOR_CATEGORIES];
    if (integrationsCategory) categories.push(integrationsCategory);
    if (customCategory) categories.push(customCategory);
    return categories;
  }, [customCategory, integrationsCategory]);

  // Tabs are query-independent, so searching never removes the active scope.
  const availableCategories = useMemo(
    () => filterNodeCreatorCategories(allCategories, allowed, '', customLabels, customDescriptions),
    [allCategories, allowed, customDescriptions, customLabels],
  );

  const queriedCategories = useMemo(
    () =>
      filterNodeCreatorCategories(allCategories, allowed, query, customLabels, customDescriptions),
    [allCategories, allowed, customDescriptions, customLabels, query],
  );

  const filtered = useMemo(
    () =>
      activeTab === NODE_CREATOR_ALL_TAB_ID
        ? queriedCategories
        : queriedCategories.filter((category) => category.id === activeTab),
    [activeTab, queriedCategories],
  );

  const tabs = useMemo<NodeCreatorTab[]>(() => {
    const total = availableCategories.reduce((count, category) => count + category.types.length, 0);
    return [
      { id: NODE_CREATOR_ALL_TAB_ID, label: 'All', count: total },
      ...availableCategories.map((category) => ({
        id: category.id,
        label: category.label,
        count: category.types.length,
      })),
    ];
  }, [availableCategories]);

  const flatTypes = useMemo(
    () => filtered.flatMap((category) => category.types.map((type) => ({ type }))),
    [filtered],
  );

  const blockTypeIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    for (let index = 0; index < flatTypes.length; index += 1) {
      const type = flatTypes[index]?.type;
      if (type !== undefined && !map.has(type)) map.set(type, index);
    }
    return map;
  }, [flatTypes]);

  const safeActiveIndex = flatTypes.length === 0 ? -1 : Math.min(activeIndex, flatTypes.length - 1);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveTab(NODE_CREATOR_ALL_TAB_ID);
    setActiveIndex(0);
  }, [open]);

  useEffect(() => {
    if (
      activeTab !== NODE_CREATOR_ALL_TAB_ID &&
      !availableCategories.some((category) => category.id === activeTab)
    ) {
      setActiveTab(NODE_CREATOR_ALL_TAB_ID);
      setActiveIndex(0);
    }
  }, [activeTab, availableCategories]);

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(0, flatTypes.length - 1)));
  }, [flatTypes.length]);

  const handleTabChange = useCallback((nextTab: string) => {
    setActiveTab(nextTab);
    setActiveIndex(0);
  }, []);

  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (flatTypes.length === 0) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((safeActiveIndex + 1) % flatTypes.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((safeActiveIndex - 1 + flatTypes.length) % flatTypes.length);
      } else if (event.key === 'Home') {
        event.preventDefault();
        setActiveIndex(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        setActiveIndex(flatTypes.length - 1);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const row = flatTypes[safeActiveIndex];
        if (row) onPick(row.type);
      }
    },
    [flatTypes, onPick, safeActiveIndex],
  );

  const title =
    mode?.kind === 'insert_edge'
      ? 'Insert step'
      : mode?.kind === 'append'
        ? 'Add connected step'
        : 'Add step';

  const activeCategoryLabel =
    activeTab === NODE_CREATOR_ALL_TAB_ID
      ? 'all steps'
      : (availableCategories.find((category) => category.id === activeTab)?.label ?? 'steps');

  const deleteTargetLabel = useMemo(() => {
    if (!deleteTargetName) return '';
    return customLabels.get(deleteTargetName) ?? deleteTargetName;
  }, [customLabels, deleteTargetName]);

  const confirmDeleteCustomNode = useCallback(async () => {
    if (!deleteTargetName) return;
    try {
      await deleteMutation.mutateAsync({ name: deleteTargetName });
      setDeleteTargetName(null);
    } catch {
      // Toast is emitted by the mutation's onError handler.
    }
  }, [deleteMutation, deleteTargetName]);

  return (
    <Fragment>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton={false}
          overlayClassName="motion-reduce:animate-none motion-reduce:transition-none"
          className={NODE_CREATOR_SHEET_SURFACE_CLASS}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <header className={NODE_CREATOR_HEADER_CLASS}>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Plus className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-left text-base font-semibold leading-tight text-foreground">
                {title}
              </DialogTitle>
              <DialogDescription className="mt-1 text-left text-xs leading-snug text-muted-foreground">
                {NODE_CREATOR_SHEET_DESCRIPTION}
              </DialogDescription>
            </div>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
                aria-label="Close add step dialog"
                iconOnly
              >
                <X className="size-4" aria-hidden />
              </Button>
            </DialogClose>
          </header>

          <Tabs
            value={activeTab}
            onValueChange={handleTabChange}
            className={NODE_CREATOR_PANEL_BODY_CLASS}
          >
            <div className={NODE_CREATOR_SEARCH_WRAP_CLASS}>
              <Input
                ref={inputRef}
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search steps…"
                size="sm"
                className={NODE_CREATOR_SEARCH_INPUT_CLASS}
                aria-label={`Search ${activeCategoryLabel}`}
                role="combobox"
                aria-expanded={open}
                aria-autocomplete="list"
                aria-controls={NODE_CREATOR_LISTBOX_ID}
                aria-activedescendant={
                  safeActiveIndex >= 0
                    ? `${NODE_CREATOR_OPTION_ID_PREFIX}${safeActiveIndex}`
                    : undefined
                }
              />
              <Search
                className="pointer-events-none absolute left-7 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
            </div>

            <div className={NODE_CREATOR_TAB_RAIL_CLASS}>
              <TabsList aria-label="Step categories" className={NODE_CREATOR_TABS_LIST_CLASS}>
                {tabs.map((tab) => (
                  <TabsTrigger key={tab.id} value={tab.id} className={NODE_CREATOR_TAB_CLASS}>
                    <span>{tab.label}</span>
                    <span aria-hidden className="ml-1.5 text-xs tabular-nums opacity-60">
                      {tab.count}
                    </span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            {tabs.map((tab) => (
              <TabsContent key={tab.id} value={tab.id} className={NODE_CREATOR_TABS_CONTENT_CLASS}>
                {activeTab === tab.id ? (
                  <NodeCreatorFilteredList
                    filtered={filtered}
                    blockTypeIndexMap={blockTypeIndexMap}
                    activeIndex={safeActiveIndex}
                    onActiveIndexChange={setActiveIndex}
                    onPick={onPick}
                    customLabels={customLabels}
                    customDescriptions={customDescriptions}
                    customBlockIcons={customBlockIcons}
                    pluginMeta={pluginMeta}
                  />
                ) : null}
              </TabsContent>
            ))}
          </Tabs>

          <footer className={NODE_CREATOR_FOOTER_CLASS}>
            <div className="min-w-0">
              {activeTab === 'custom' && customCategory ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1.5 px-2 text-destructive hover:text-destructive"
                      aria-label="Choose a custom node to remove"
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                      Remove custom node…
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="start" sideOffset={6} className="w-64">
                    {customCategory.types.map((type) => (
                      <DropdownMenuItem
                        key={type}
                        className="text-destructive focus:text-destructive"
                        onSelect={() => setDeleteTargetName(type)}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                        <span className="truncate">{customLabels.get(type) ?? type}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
              <span aria-live="polite" aria-atomic="true" className="tabular-nums">
                {resultCountLabel(flatTypes.length)}
              </span>
              <span aria-hidden className="hidden sm:inline">
                Search: ↑↓ browse · Enter add · Esc close
              </span>
            </div>
          </footer>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTargetName !== null}
        onOpenChange={(next) => {
          if (next || deleteMutation.isPending) return;
          setDeleteTargetName(null);
        }}
      >
        <AlertDialogContent aria-busy={deleteMutation.isPending}>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove custom node from catalog?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTargetName ? (
                <span className="block">
                  &quot;{deleteTargetLabel}&quot; will be removed from your catalog and its folder
                  under ~/.frink/nodes/ (if present). Saved credentials for this node are cleared.
                  Steps already on a flow canvas are not removed.
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending}
              onClick={() => void confirmDeleteCustomNode()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
              ) : (
                'Remove'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Fragment>
  );
}
