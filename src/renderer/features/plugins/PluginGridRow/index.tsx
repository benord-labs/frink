import { cn } from '@benord-labs/frink-primitives';
import { ChevronRight } from 'lucide-react';
import { groupIdFor } from '../../../lib/plugins/plugin-filters';
import {
  type PluginStatus,
  type PluginToolsState,
  resolvePluginStatus,
} from '../../../lib/plugins/plugin-view-model';
import { PluginMark } from '../PluginMark';

// Sourced from the filter helper so this UI folder never duplicates the model type.
type ResolvedPlugin = Parameters<typeof groupIdFor>[0];

type Props = {
  plugin: ResolvedPlugin;
  /** The plugin's tools grant as the status poll reports it; 'unknown' until that query settles. */
  tools?: PluginToolsState;
  onOpen: (pluginId: string) => void;
};

/**
 * The chip tint is mixed from its own text colour so danger tracks whatever that
 * token resolves to per theme. `bg-secondary` is deliberately avoided: frink
 * remaps `--secondary` to a neutral grey while the primitives' jade ramp stays
 * put, so that pairing renders an invisible tint.
 */
/**
 * Carries no in-flight connect state, which is safe only because a connect in
 * flight is always covered by the blocking dialog Integrations holds open for
 * the whole lifetime of `connectingProvider` — NOT because the directory is
 * hidden, which `PluginsPanel`'s `accountDialogProvider` effect can undo
 * mid-connect.
 */
export function PluginGridRow({ plugin, tools = 'unknown', onOpen }: Props) {
  const { id, name, description } = plugin.definition;
  const group = groupIdFor(plugin, tools);
  // The one status this row shows. Computed once and handed to every consumer
  // below, so the mark, the section and the screen-reader label cannot disagree.
  const status = resolvePluginStatus(plugin, tools);
  const comingSoon = status.id === 'coming_soon';

  return (
    // Marks the row so the detail page can hand focus back to it on close; the
    // button beneath is what actually takes focus.
    <li data-plugin-row={id} className="border-hairline">
      <button
        type="button"
        disabled={comingSoon}
        onClick={() => onOpen(id)}
        className="flex w-full cursor-pointer items-center gap-3.5 rounded-[10px] px-2 py-3 text-left transition-colors duration-150 ease-out enabled:hover:bg-foreground/5 disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg motion-reduce:transition-none"
      >
        <PluginMark
          pluginId={id}
          className="size-10 rounded-xl"
          markSize="1.5rem"
          dimmed={group === 'coming_soon'}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-ink text-sm">{name}</span>
          <span className="mt-0.5 block truncate text-sm text-muted-fg">{description}</span>
        </span>
        <RowStatus status={status} />
        {!comingSoon && <ChevronRight className="size-4 shrink-0 text-dim" aria-hidden />}
      </button>
    </li>
  );
}

const MARKED_STATUS_IDS = new Set<PluginStatus['id']>(['disabled']);
const ANNOUNCED_ONLY_STATUS_IDS = new Set<PluginStatus['id']>([
  'connected',
  'coming_soon',
  'unavailable',
]);

/**
 * A visible mark means SOMETHING NEEDS ATTENTION; silence means healthy. The
 * plain states — connected, coming soon, unavailable — are stated once by the
 * section heading the row sits under, so repeating them on every row beneath it
 * is noise. They still ANNOUNCE, because a screen-reader user moving row to row
 * does not carry the heading with them.
 *
 * Renders the status it is given and derives nothing of its own, so a row and
 * its own page cannot label one plugin two different things.
 */
function RowStatus({ status }: { status: PluginStatus }) {
  // Turned off earns a visible mark despite naming no failure: `groupIdFor`
  // files it under the CONNECTED heading, so silence there would assert
  // "connected" about a plugin the user switched off.
  if (MARKED_STATUS_IDS.has(status.id)) {
    return (
      <span className="shrink-0 text-xs text-dim" data-testid="plugin-row-status">
        {status.label}
      </span>
    );
  }

  if (ANNOUNCED_ONLY_STATUS_IDS.has(status.id)) {
    return <span className="sr-only">{status.label}</span>;
  }

  return null;
}
