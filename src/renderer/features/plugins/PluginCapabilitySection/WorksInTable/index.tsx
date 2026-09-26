/**
 * Rows are chat runtimes, columns are what a plugin gives you. A runtime that loads
 * nothing keeps its row, with each unavailable capability marked explicitly.
 */
import { Check, Minus } from 'lucide-react';
import type { PluginRuntimeDelivery } from '../../../../../shared/integrations/plugins';
import type { PluginCapabilityRow } from '../../../../lib/plugins/plugin-view-model';

type Items = PluginCapabilityRow['items'];

const COLUMNS: ReadonlyArray<{ key: keyof PluginRuntimeDelivery; label: string }> = [
  { key: 'skills', label: 'Skills' },
  { key: 'commands', label: 'Slash commands' },
  { key: 'mcp', label: 'MCP tools' },
  { key: 'flowTriggers', label: 'Flow triggers' },
  { key: 'flowActions', label: 'Flow actions' },
];

const HEAD_CELL = 'pb-1.5 pr-2 text-left font-medium text-muted-fg text-xs last:pr-0';

export function WorksInTable({ items }: { items: Items }) {
  return (
    <table className="mt-2.5 w-full border-collapse">
      <caption className="sr-only">Where this plugin works and what it gives you there</caption>
      <thead>
        <tr>
          <th scope="col" className={`${HEAD_CELL} @[34rem]:w-[9rem]`}>
            <span className="sr-only">Runtime</span>
          </th>
          {COLUMNS.map((column) => (
            <th key={column.key} scope="col" className={HEAD_CELL}>
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            <th scope="row" className="py-1 pr-3 text-left font-normal text-sm text-ink">
              {item.label}
            </th>
            {COLUMNS.map((column) => (
              <td key={column.key} className="py-1">
                <DeliveryCell delivered={item.delivers?.[column.key] === true} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A glyph for the eye and a word for the screen reader; the glyph alone says nothing aloud. */
function DeliveryCell({ delivered }: { delivered: boolean }) {
  return delivered ? (
    <>
      <Check className="size-3.5 text-ink" aria-hidden />
      <span className="sr-only">Yes</span>
    </>
  ) : (
    <>
      <Minus className="size-3.5 text-dim" aria-hidden />
      <span className="sr-only">No</span>
    </>
  );
}
