/**
 * Searchable, virtualised picker over a plugin server's live tools/list for the generic call-tool
 * node. Read-only tools sort first; a destructive hint is a badge, never authority.
 */
import { Button } from '@benord-labs/frink-primitives';
import { type ReactElement, type ReactNode, useMemo, useState } from 'react';
import { Badge } from '../../../../../../components/ui/badge';
import { Check, ChevronDown } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../../../../../../components/ui/popover';
import { VirtualSearchList } from '../../../../../../components/ui/virtual-search-list';
import { useSettingsNavigation } from '../../../../../../hooks/useSettingsNavigation';
import { createHighlightMatcher } from '../../../../../../lib/highlight-match';
import { cn } from '../../../../../../lib/utils';
import type { ManifestInput } from '../../SchemaFields';
import { FieldRow } from '../../shared';

/** One row of `customNodes.pluginServerTools`: the projected form plus the two advisory hints. */
export type PluginTool = {
  name: string;
  title?: string;
  description?: string;
  readOnly: boolean;
  destructive: boolean;
  inputs: Record<string, ManifestInput>;
  unsupportedFields: string[];
};

/** `undefined` while the list is loading; a typed failure names why the server could not be read. */
export type PluginToolsState =
  | { ok: true; tools: PluginTool[] }
  | { ok: false; reason: string }
  | undefined;

const ROW_HEIGHT = 44;
const LIST_MAX_HEIGHT = 320;
const OVERSCAN = 8;

function toolLabel(tool: PluginTool): string {
  return tool.title ?? tool.name;
}

function sortedTools(tools: PluginTool[]): PluginTool[] {
  return [...tools].sort(
    (a, b) => Number(b.readOnly) - Number(a.readOnly) || toolLabel(a).localeCompare(toolLabel(b)),
  );
}

function searchText(tool: PluginTool): string {
  return `${tool.name} ${tool.title ?? ''} ${tool.description ?? ''}`.toLowerCase();
}

function triggerText(tools: PluginToolsState, selected: PluginTool | undefined, value: string) {
  if (tools === undefined) return 'Loading tools…';
  if (selected) return toolLabel(selected);
  return value || 'Choose a tool…';
}

function hintText(tools: PluginToolsState, selected: PluginTool | undefined, value: string) {
  if (selected) return selected.description;
  return value !== '' && tools?.ok ? 'This tool is no longer offered by the server.' : undefined;
}

function UnreadableServer({ reason }: { reason: string }): ReactElement {
  const { openSettingsTab } = useSettingsNavigation();
  return (
    <FieldRow label="Tool" error={reason}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => openSettingsTab('integrations')}
      >
        Open Settings → Plugins
      </Button>
    </FieldRow>
  );
}

function ToolRow({
  tool,
  selected,
  highlight,
  onPick,
}: {
  tool: PluginTool;
  selected: boolean;
  highlight: (text: string) => ReactNode;
  onPick: (tool: PluginTool) => void;
}): ReactElement {
  return (
    <Button
      variant="ghost"
      size="auto"
      role="option"
      aria-selected={selected}
      aria-label={toolLabel(tool)}
      onClick={() => onPick(tool)}
      className={cn(
        'flex h-full w-full flex-col items-start gap-0.5 rounded-md px-2 py-1 text-left font-normal',
        selected ? 'bg-primary/10 text-foreground' : 'hover:bg-accent hover:text-accent-foreground',
      )}
    >
      <span className="flex w-full items-center gap-1.5">
        <span className="truncate text-sm">{highlight(toolLabel(tool))}</span>
        {tool.destructive && (
          <Badge variant="destructive" className="text-[10px]">
            changes data
          </Badge>
        )}
        {selected && <Check className="ml-auto h-4 w-4 shrink-0" aria-hidden />}
      </span>
      {tool.description && (
        <span className="w-full truncate text-xs text-muted-foreground">{tool.description}</span>
      )}
    </Button>
  );
}

type Props = {
  fieldId: string;
  value: string;
  tools: PluginToolsState;
  onChange: (tool: string) => void;
};

export function ToolPickerField({ fieldId, value, tools, onChange }: Props): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rows = useMemo(() => (tools?.ok ? sortedTools(tools.tools) : []), [tools]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? rows.filter((tool) => searchText(tool).includes(needle)) : rows;
  }, [rows, query]);
  const highlight = useMemo(() => createHighlightMatcher(query), [query]);
  const selected = rows.find((tool) => tool.name === value);

  if (tools && !tools.ok) return <UnreadableServer reason={tools.reason} />;

  const handleOpenChange = (next: boolean) => {
    if (!next) setQuery('');
    setOpen(next);
  };
  const pick = (tool: PluginTool) => {
    // Re-picking the current tool is not a change: the consumer resets the arguments on change.
    if (tool.name !== value) onChange(tool.name);
    handleOpenChange(false);
  };

  return (
    <FieldRow
      htmlFor={fieldId}
      label="Tool"
      hint={hintText(tools, selected, value)}
      error={value === '' ? 'Tool is required.' : undefined}
    >
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            id={fieldId}
            type="button"
            variant="secondary"
            disabled={tools === undefined}
            className="flex h-9 w-full justify-between gap-2 rounded-[10px] px-3 py-2 text-start text-sm text-foreground"
          >
            <span className="truncate">{triggerText(tools, selected, value)}</span>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground/80" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-96 p-0" align="start">
          <VirtualSearchList
            items={filtered}
            itemKey={(tool) => tool.name}
            rowHeight={ROW_HEIGHT}
            maxHeight={LIST_MAX_HEIGHT}
            overscan={OVERSCAN}
            open={open}
            query={query}
            onQueryChange={setQuery}
            searchPlaceholder={`Search ${rows.length} tools…`}
            searchLabel="Search tools"
            listLabel="Tools"
            emptyText="No tools match."
            renderRow={(tool) => (
              <ToolRow
                tool={tool}
                selected={tool.name === value}
                highlight={highlight}
                onPick={pick}
              />
            )}
          />
        </PopoverContent>
      </Popover>
    </FieldRow>
  );
}
