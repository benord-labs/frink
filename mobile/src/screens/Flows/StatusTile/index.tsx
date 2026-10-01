import type { Status } from '../../../lib/status';
import { StatusGlyph } from '../../../ui/glyphs';
import { Tile } from '../Tile';

/** A run's state glyph in the list's leading tile. */
export function StatusTile({ status }: { status: Status }) {
  return (
    <Tile>
      <StatusGlyph glyph={status.glyph} tone={status.tone} size={19} />
    </Tile>
  );
}
