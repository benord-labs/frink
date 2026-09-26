import { Input, Tabs } from '@benord-labs/frink-primitives';
import { Search } from 'lucide-react';
import type { PluginFilter, PluginFilterId } from '../../../../lib/plugins/plugin-filters';

type Props = {
  filters: PluginFilter[];
  active: PluginFilterId;
  query: string;
  onFilterChange: (id: PluginFilterId) => void;
  onQueryChange: (query: string) => void;
};

export function DirectoryToolbar({ filters, active, query, onFilterChange, onQueryChange }: Props) {
  return (
    <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
      <Tabs
        items={filters.map((entry) => ({
          value: entry.id,
          label: (
            <span className="flex items-center gap-1.5">
              {entry.label}
              {/* Hidden from the accessible name so the tab is addressable by its label alone rather than "All 3". */}
              <span aria-hidden className="text-xs tabular-nums opacity-55">
                {entry.count}
              </span>
            </span>
          ),
        }))}
        value={active}
        onValueChange={(next) => onFilterChange(next as PluginFilterId)}
      />
      <div className="relative ml-auto w-full min-w-[11rem] max-w-[16rem] flex-1">
        <label htmlFor="plugin-search" className="sr-only">
          Search plugins
        </label>
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-dim"
        />
        <Input
          id="plugin-search"
          size="sm"
          type="search"
          value={query}
          placeholder="Search"
          onChange={(event) => onQueryChange(event.target.value)}
          className="pl-8"
        />
      </div>
    </div>
  );
}
