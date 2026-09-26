import { useAtomValue } from 'jotai';
import { type ReactElement, useId, useState } from 'react';
import { HexColorPicker } from 'react-colorful';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { agentsSettingsDialogOpenAtom } from '@/lib/atoms';
import { parseHexColor } from '@/lib/themes/editor/draft';
import { useFrameCoalesced } from '@/lib/themes/editor/use-frame-coalesced';
import { overlayGlass } from '@/lib/overlay-styles';
import { cn } from '@/lib/utils';

// Swatches carry the tile's cut corner (slope 1:2) at their own scale.
const SWATCH = {
  seed: { className: 'h-[38px] w-full rounded-[7px]', cut: 22 },
  row: { className: 'size-5 rounded-[5px]', cut: 8 },
} as const;

const cutCorner = (width: number): string =>
  `polygon(0 0, calc(100% - ${width}px) 0, 100% ${width / 2}px, 100% 100%, 0 100%)`;

type Props = {
  label: string;
  /** `#rrggbb` */
  value: string;
  onChange: (hex: string) => void;
  /** `seed`: the tile's wide swatch; `row`: the colour list's small one. */
  size: keyof typeof SWATCH;
  /** Places the swatch (which opens the picker) and the hex field. */
  children: (parts: { swatch: ReactElement; hex: ReactElement }) => ReactElement;
};

/**
 * A swatch that opens a colour picker, plus a hex field that commits only complete `#rrggbb`
 * values ('#' optional). Picker drags reach `onChange` at most once per frame.
 */
export function ColorField({ label, value, onChange, size, children }: Props): ReactElement {
  // Local while a pick is in flight, so the picker never snaps back to a value a frame old.
  const [picked, setPicked] = useState<string | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const commit = useFrameCoalesced((hex: string) => {
    setPicked(null);
    onChange(hex);
  });
  const shown = picked ?? value;
  const invalid = typed !== null && parseHexColor(typed) === null;
  const hintId = useId();
  const [open, setOpen] = useState(false);
  const settingsOpen = useAtomValue(agentsSettingsDialogOpenAtom);
  // Settings hides the dock, but not this picker portaled out of it, so Settings closes it.
  if (open && settingsOpen) setOpen(false);

  // The focus ring sits on the button, outside the cut, so the corner never clips it.
  const swatch = (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) commit.flush();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Choose ${label} color`}
          className={cn(
            'shrink-0 outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
            SWATCH[size].className,
          )}
        >
          <span
            className="block size-full rounded-[inherit] shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.2)]"
            style={{ backgroundColor: shown, clipPath: cutCorner(SWATCH[size].cut) }}
          />
        </button>
      </PopoverTrigger>
      {/* Ignored by Inspect like the panel itself. */}
      <PopoverContent
        data-theme-editor-panel=""
        align="end"
        className="w-auto min-w-0 p-3"
        onPointerDownCapture={() =>
          window.addEventListener('pointerup', commit.flush, { once: true })
        }
      >
        <HexColorPicker
          color={shown}
          onChange={(hex) => {
            setPicked(hex);
            commit.push(hex);
          }}
        />
      </PopoverContent>
    </Popover>
  );

  const hex = (
    <span className="relative shrink-0">
      <input
        aria-label={`${label} hex value`}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? hintId : undefined}
        spellCheck={false}
        maxLength={7}
        value={typed ?? shown}
        onFocus={() => setTyped(shown)}
        onBlur={() => setTyped(null)}
        onChange={(event) => {
          const text = event.currentTarget.value;
          setTyped(text);
          const parsed = parseHexColor(text);
          if (parsed) onChange(parsed);
        }}
        className="field-sizing-content min-w-[7ch] rounded-sm bg-transparent px-1 text-right font-mono text-xs font-normal text-muted-foreground outline-hidden hover:bg-input-background focus:bg-input-background focus:text-foreground focus-visible:ring-1 focus-visible:ring-ring aria-invalid:text-destructive aria-invalid:ring-1 aria-invalid:ring-destructive"
      />
      {invalid ? (
        <span
          id={hintId}
          className={cn(
            'absolute top-full right-0 z-10 mt-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs text-destructive shadow-md',
            overlayGlass,
          )}
        >
          Use a color like #1a2b3c
        </span>
      ) : null}
    </span>
  );

  return children({ swatch, hex });
}
