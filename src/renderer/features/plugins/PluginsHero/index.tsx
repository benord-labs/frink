/** Shared theme palette and chain steps for the plugin detail carousel. */
import { Workflow } from 'lucide-react';
import { BRAND_TILE_STYLE, ProviderIcon } from '../../../components/ProviderIcon';

/** The carousel's copy and controls follow the active app theme. */
export const HERO_INK = 'hsl(var(--foreground))';
export const HERO_DIM = 'hsl(var(--foreground) / 0.7)';
const HERO_PILL = 'hsl(var(--card) / 0.85)';
const HERO_PILL_RIM = 'hsl(var(--border))';

/** Original metal ground, used only behind the dark-theme artwork. */
export const HERO_BAND = 'linear-gradient(115deg, #050505 0%, #363636 52%, #050505 100%)';

/** One half of the cause-and-effect chain on the plugin detail band. */
export function ChainStep({
  pluginId,
  label,
  detail,
  caption,
}: {
  pluginId?: string;
  label: string;
  detail: string;
  caption: string;
}) {
  const hasProvider = pluginId !== undefined;

  return (
    <div className="flex min-w-0 max-w-full flex-col items-start gap-1.5">
      <span className="text-xs" style={{ color: HERO_DIM }}>
        {caption}
      </span>
      <div
        className="flex min-w-0 max-w-full items-center gap-2.5 rounded-full border py-1.5 pr-4 pl-1.5"
        style={{ background: HERO_PILL, borderColor: HERO_PILL_RIM }}
      >
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-full"
          style={hasProvider ? BRAND_TILE_STYLE : undefined}
        >
          {pluginId ? (
            <ProviderIcon providerId={pluginId} appearance="tile" className="size-[0.9rem]" />
          ) : (
            <Workflow className="size-3.5 text-primary" aria-hidden />
          )}
        </span>
        <span className="min-w-0 truncate text-sm">
          <span style={{ color: HERO_INK }}>{label}</span>
          <span style={{ color: HERO_DIM }}> · {detail}</span>
        </span>
      </div>
    </div>
  );
}
