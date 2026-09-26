import type { PluginCapabilityRow } from '../../../../lib/plugins/plugin-view-model';
import { PluginCapabilitySection } from '../../PluginCapabilitySection';

/** One loud tier: 3rem to the tier above, 1.75rem between members. */
export function CapabilityTier({
  rows,
  variant,
}: {
  rows: PluginCapabilityRow[];
  variant?: 'chips';
}) {
  return (
    <div className="mt-12 space-y-7">
      {rows.map((row) => (
        <PluginCapabilitySection key={row.id} row={row} variant={variant} />
      ))}
    </div>
  );
}
