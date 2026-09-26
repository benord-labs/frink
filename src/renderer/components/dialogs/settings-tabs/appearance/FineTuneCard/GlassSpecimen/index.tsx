import type { CSSProperties, ReactElement } from 'react';
import { glassVars } from '@/lib/themes/palette/glass';
import type { Appearance, Palette } from '@/lib/themes/palette/roles';
import { withAlpha as alpha } from '@/lib/themes/preview/theme-palette';

const CHATS = ['Build speed', 'Release notes', 'Login bug', 'Hero copy'];
const MENU = ['Copy', 'Retry', 'Branch from here'];

const type = (size: number, weight = 400): CSSProperties => ({
  fontSize: size,
  fontWeight: weight,
  lineHeight: 1.5,
});

type Props = {
  /** The palette on screen, contrast included; null until stock Frink is read. */
  palette: Palette | null;
  appearance: Appearance;
  /** Transparency level; 0 when the OS keeps surfaces solid. */
  level: number;
};

/**
 * A sidebar, card and menu over the chat atmosphere at `level`, painted inline from the same glass
 * vars the app writes, so it shows what the slider does wherever Settings sits.
 */
export function GlassSpecimen({ palette: p, appearance, level }: Props): ReactElement {
  if (!p) return <div className="h-[212px]" />;
  // SAFETY: CSSProperties has no custom-property keys; the children read these.
  const vars = glassVars(level, appearance) as CSSProperties;
  return (
    <div
      aria-hidden
      data-glass-specimen
      className="chat-canvas-atmosphere relative h-[212px] overflow-hidden rounded-xl"
      style={{
        ...vars,
        backgroundColor: p.background,
        boxShadow: `inset 0 0 0 1px ${alpha(p.border, '80%')}`,
      }}
    >
      <div className="absolute top-3.5 right-3.5 left-[120px] flex flex-col gap-1">
        <p style={{ ...type(12, 600), color: p.text }}>Why is the build slow?</p>
        <p style={{ ...type(11), color: p.text }}>
          Most of the time goes to type-checking the whole project on every save. Turning on
          incremental builds should cut it to a few seconds.
        </p>
        <p style={{ ...type(11), color: p.mutedText }}>Checked 3 config files · 2 minutes ago</p>
      </div>
      <div
        className="glass-lit absolute top-2 bottom-2 left-2 flex w-[100px] flex-col gap-1.5 rounded-[9px] px-2 py-2.5"
        style={{
          backgroundColor: alpha(p.surface, 'var(--glass-opacity)'),
          border: `1px solid ${alpha(p.border, '70%')}`,
        }}
      >
        <p style={{ ...type(11, 600), color: p.text }}>Chats</p>
        {CHATS.map((chat, index) => (
          <p
            key={chat}
            className="rounded-[5px] px-[5px] py-px"
            style={{
              ...type(10),
              color: index === 0 ? p.text : p.mutedText,
              backgroundColor: index === 0 ? alpha(p.text, '8%') : undefined,
            }}
          >
            {chat}
          </p>
        ))}
      </div>
      <div
        className="glass-lit absolute bottom-3.5 left-32 flex w-[170px] flex-col gap-[3px] rounded-[9px] px-2.5 py-2"
        style={{
          backgroundColor: alpha(p.surface, 'var(--glass-opacity)'),
          border: `1px solid ${alpha(p.border, '80%')}`,
        }}
      >
        <p className="flex items-center gap-1.5" style={{ ...type(11, 500), color: p.text }}>
          <span className="size-1.5 rounded-full" style={{ backgroundColor: p.accent }} />
          Ran 3 checks
        </p>
        <p style={{ ...type(10), color: p.mutedText }}>All passed in 4.2s</p>
      </div>
      <div
        className="glass-lit absolute top-[62px] right-4 w-[138px] rounded-[9px] p-1 shadow-[0_10px_28px_-10px_rgb(0_0_0/0.5)]"
        style={{
          backgroundColor: alpha(p.overlay, 'var(--glass-opacity)'),
          backdropFilter: 'var(--glass-filter)',
          border: `1px solid ${alpha(p.border, 'var(--glass-opacity)')}`,
        }}
      >
        {MENU.map((item, index) => (
          <p
            key={item}
            className="flex h-[23px] items-center rounded-[5px] px-2"
            style={{
              ...type(11, 500),
              color: p.text,
              backgroundColor: index === 1 ? alpha(p.text, '8%') : undefined,
            }}
          >
            {item}
          </p>
        ))}
      </div>
      <span
        className="absolute right-2.5 bottom-2.5 z-10 rounded-md px-[7px] text-[11px] leading-5 font-medium"
        style={{
          color: p.text,
          backgroundColor: alpha(p.background, '75%'),
          boxShadow: `inset 0 0 0 1px ${alpha(p.border, '90%')}`,
        }}
      >
        Live preview
      </span>
    </div>
  );
}
