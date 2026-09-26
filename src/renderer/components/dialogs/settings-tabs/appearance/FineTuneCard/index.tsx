import { Button } from '@benord-labs/frink-primitives';
import { useAtom, useAtomValue, useStore } from 'jotai';
import { RotateCcw } from 'lucide-react';
import { useTheme } from 'next-themes';
import { type CSSProperties, type ReactElement, useId, useMemo } from 'react';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { applyGlass, applyPalette } from '@/lib/themes/palette/apply';
import { findTheme } from '@/lib/themes/palette/built-in-themes';
import {
  applyContrast,
  CONTRAST_RANGE,
  contrastToPosition,
  positionToContrast,
} from '@/lib/themes/palette/contrast';
import { TRANSPARENCY_SCALE } from '@/lib/themes/palette/glass';
import { resolveActivePalette } from '@/lib/themes/palette/resolve';
import type { Appearance, Palette } from '@/lib/themes/palette/roles';
import {
  contrastAtom,
  customThemesAtom,
  previewActiveAtom,
  themeHalvesAtom,
  transparencyAtom,
} from '@/lib/themes/palette/theme-atoms';
import { themeHalfPalette } from '@/lib/themes/preview/theme-palette';
import { useLiveValue } from '@/lib/themes/preview/use-live-value';
import { usePrefersReducedTransparency } from '@/lib/themes/preview/use-reduced-transparency';
import { cn } from '@/lib/utils';
import { GlassSpecimen } from './GlassSpecimen';

const TRANSPARENCY_READOUTS = ['Solid', 'Low', 'Standard', 'High', 'See-through'] as const;
const CONTRAST_TICKS = [0, 50, 100];
const TRANSPARENCY_TICKS = [0, 25, 50, 75, 100];

function contrastReadout(contrast: number): string {
  if (contrast === CONTRAST_RANGE.default) return 'Standard';
  return `${contrast > CONTRAST_RANGE.default ? 'Sharper' : 'Softer'} · ${contrast}%`;
}

type SliderProps = {
  title: string;
  description: string;
  /** Right of the title and the slider's `aria-valuetext`. */
  readout: string;
  live: ReturnType<typeof useLiveValue>;
  step: number;
  /** Track fill as [from, to] positions (0–100). */
  fill: readonly [number, number];
  /** Tick positions; the centre one is the major tick. */
  ticks: readonly number[];
  ends: readonly [start: string, centre: string, end: string];
  /** Why the slider is off, when it is. */
  disabledNote?: string;
};

/** A 0–100 slider with a readout, ticks under the track and three end labels. */
function FineTuneSlider({
  title,
  description,
  readout,
  live,
  step,
  fill,
  ticks,
  ends,
  disabledNote,
}: SliderProps): ReactElement {
  const descriptionId = useId();
  // SAFETY: CSSProperties has no custom-property keys; `.range-slider` reads these.
  const track = {
    '--range-from': `${fill[0]}%`,
    '--range-to': `${fill[1]}%`,
  } as CSSProperties;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-sm font-medium text-foreground">{title}</h4>
        <span className="text-xs font-medium whitespace-nowrap text-foreground tabular-nums">
          {readout}
        </span>
      </div>
      <p id={descriptionId} className="text-[13px] text-muted-foreground">
        {description}
      </p>
      <div className="mt-2">
        <input
          ref={live.inputRef}
          type="range"
          aria-label={title}
          aria-describedby={descriptionId}
          aria-valuetext={readout}
          min={0}
          max={100}
          step={step}
          value={live.value}
          disabled={disabledNote !== undefined}
          onChange={live.onChange}
          style={track}
          className="range-slider block w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        />
        {/* Inset by half the thumb, so each tick sits under the thumb's centre at that value. */}
        <div aria-hidden className="pointer-events-none relative mx-3.5 mt-1 h-1.5">
          {ticks.map((tick) => (
            <span
              key={tick}
              className={cn(
                'absolute bottom-0 w-px -translate-x-1/2',
                tick === 50 ? 'h-1.5 bg-muted-foreground' : 'h-1 bg-muted-foreground/55',
              )}
              style={{ left: `${tick}%` }}
            />
          ))}
        </div>
      </div>
      <div
        aria-hidden
        className="mt-0.5 grid grid-cols-[1fr_auto_1fr] text-xs text-muted-foreground"
      >
        <span>{ends[0]}</span>
        <span>{ends[1]}</span>
        <span className="text-right">{ends[2]}</span>
      </div>
      {disabledNote ? <p className="mt-1 text-xs text-muted-foreground">{disabledNote}</p> : null}
    </div>
  );
}

type Props = {
  /** Stock Frink as globals.css paints it; null until read. */
  stock: Record<Appearance, Palette> | null;
};

/**
 * Contrast and Transparency, which work on top of any theme. Both preview live while dragged,
 * once per frame, and apply on release; the specimen repaints with them.
 */
export function FineTuneCard({ stock }: Props): ReactElement {
  const [contrast, setContrast] = useAtom(contrastAtom);
  const [transparency, setTransparency] = useAtom(transparencyAtom);
  const halves = useAtomValue(themeHalvesAtom);
  const customThemes = useAtomValue(customThemesAtom);
  const store = useStore();
  const solid = usePrefersReducedTransparency();
  const { resolvedTheme } = useTheme();
  const appearance: Appearance = resolvedTheme === 'dark' ? 'dark' : 'light';

  // Standard sits dead centre, so the contrast input holds a position, not a percentage.
  const contrastLive = useLiveValue(
    contrastToPosition(contrast),
    (position) => {
      // While the theme editor previews a draft it owns <html>; stored values reach it on release.
      // Read at paint time: a frame scheduled mid-drag can land after the editor has opened.
      if (store.get(previewActiveAtom)) return;
      const value = positionToContrast(position);
      applyPalette(resolveActivePalette({ halves, customThemes, appearance, contrast: value }));
    },
    (position) => setContrast(positionToContrast(position)),
  );
  const transparencyLive = useLiveValue(
    transparency,
    (value) => {
      if (!store.get(previewActiveAtom)) applyGlass(value, appearance);
    },
    setTransparency,
    solid,
  );
  const liveContrast = positionToContrast(contrastLive.value);
  const base = themeHalfPalette(findTheme(halves[appearance], customThemes), appearance, stock);
  const specimen = useMemo(() => base && applyContrast(base, liveContrast), [base, liveContrast]);
  const centre = contrastToPosition(CONTRAST_RANGE.default);
  const offDefault =
    contrast !== CONTRAST_RANGE.default || transparency !== TRANSPARENCY_SCALE.default;

  return (
    <SettingsCard>
      <div className="grid gap-6 p-5 @min-[980px]:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex flex-col justify-center gap-5">
          <FineTuneSlider
            title="Contrast"
            description="Make text and lines stand out more, or less."
            readout={contrastReadout(liveContrast)}
            live={contrastLive}
            step={5}
            fill={[Math.min(centre, contrastLive.value), Math.max(centre, contrastLive.value)]}
            ticks={CONTRAST_TICKS}
            ends={['Softer', 'Standard', 'Sharper']}
          />
          <FineTuneSlider
            title="Transparency"
            description="How see-through panels, cards and menus are."
            readout={
              TRANSPARENCY_READOUTS[Math.round(transparencyLive.value / TRANSPARENCY_SCALE.step)]
            }
            live={transparencyLive}
            step={TRANSPARENCY_SCALE.step}
            fill={[0, transparencyLive.value]}
            ticks={TRANSPARENCY_TICKS}
            ends={['Solid', 'Standard', 'See-through']}
            disabledNote={
              solid ? "Your computer's accessibility settings keep panels solid." : undefined
            }
          />
          <div className="min-h-7">
            {offDefault ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setContrast(CONTRAST_RANGE.default);
                  setTransparency(TRANSPARENCY_SCALE.default);
                }}
              >
                <RotateCcw className="size-3.5" />
                Reset both
              </Button>
            ) : null}
          </div>
        </div>
        <GlassSpecimen
          palette={specimen}
          appearance={appearance}
          level={solid ? 0 : transparencyLive.value}
        />
      </div>
    </SettingsCard>
  );
}
