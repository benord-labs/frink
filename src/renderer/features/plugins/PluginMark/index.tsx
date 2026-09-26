import { cn } from '@benord-labs/frink-primitives';
import { BRAND_TILE_RIM_STYLE, ProviderIcon } from '../../../components/ProviderIcon';

type Props = {
  pluginId: string;
  /** Plate geometry (size + radius); the plate itself is always the fixed brand tile. */
  className: string;
  /** Inline so a parent's `[&_svg]:size-4` cannot win the tie. */
  markSize: string;
  /** Coming-soon rows keep the shape but lose the brand. */
  dimmed?: boolean;
};

/** The provider's logo on its light app-icon plate, shared by every plugin surface. */
export function PluginMark({ pluginId, className, markSize, dimmed = false }: Props) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden',
        className,
        dimmed && 'opacity-70 grayscale',
      )}
      style={BRAND_TILE_RIM_STYLE}
    >
      <ProviderIcon
        providerId={pluginId}
        appearance="tile"
        style={{ width: markSize, height: markSize }}
      />
    </span>
  );
}
