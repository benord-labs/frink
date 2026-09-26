/**
 * Layout vocabulary shared by both flow bottom surfaces (FlowRunStrip, FlowPausedBar): the card
 * shell, its container-query tiers, and the one button shape its action row accepts.
 *
 * The card reads top-down as context, then the live line, then typing:
 *
 *   [Auto on] [Agent] [Opus 5 . High]                        <- context, set once, quiet
 *   Running Build step        [note] [Pause] [Stop]          <- what is happening + what you can do
 *   [ Steer the running step                              ]  <- only when there is text to enter
 *
 * WHY THIS SPLIT. The three groups are a fixed-width readout (245px), a fixed-width action group
 * (254px) and one elastic sentence. Putting all three on one row is what the card used to do, and it
 * left the sentence as the only thing able to yield: at a 300px pane it truncated to "Runn..." while
 * three pills and three buttons kept their words.
 *
 * Splitting them was easy; balancing them was not. Giving the sentence a line of its OWN reads badly
 * for the common case, because the common label is short ("Flow running...", ~110px) and a line that
 * is 80% empty above a full one looks broken rather than hierarchical. So the quiet, static context
 * takes the top line, where trailing space reads as a caption and costs nothing, and the sentence
 * shares the line below with the controls, which anchors BOTH edges of the row you actually look at.
 * That row also sits directly above the input, which is where the note you are about to type goes.
 *
 * Vertical budget, priced rather than guessed: 18px context + 6px + 28px live row = 52px, against
 * 40px for the old single row. The extra 12px is paid in every pane of every split, which is why
 * the context line collapses out entirely (`empty:hidden`) in the taskless windows between nodes
 * where there are no pills to show.
 */
import { Button } from '@benord-labs/frink-primitives';
import type { ReactNode, Ref } from 'react';
import { agentsChatComposerShellClass } from '../../../../chat-composer-shell-classes';

/**
 * Container-query tiers. They reflow on the CARD's width, never the viewport: a split pane can be
 * 300px wide inside a 2000px window, and pane width is pure CSS flexGrow from a ratio custom
 * property, so there is no pixel value in JS to observe and ZoomWrapper's CSS `zoom` would skew any
 * getBoundingClientRect reading anyway.
 *
 * Every tier is written `@max-*`: it SUBTRACTS at narrow widths rather than adding at wide ones. A
 * container query with no `@container` ancestor never matches, so this direction degrades to
 * "everything visible" if the wrapper is ever moved or removed. The `@min-` direction would fail the
 * other way, to permanently glyph-only at every width, and no happy-dom test could catch it because
 * happy-dom resolves no container queries at all.
 *
 * Labels shed with `sr-only`, never `hidden`: the pill icons are aria-hidden, so `hidden` would
 * delete the model, mode and permission state from the accessibility tree at exactly the width where
 * the visual conveys least.
 *
 * SHED ORDER: reference loses its words a full tier before controls do. A chip restates something
 * you already chose and can re-read in the flow editor, so a glyph plus its tooltip is enough; a
 * button you are about to press should keep saying what it does for as long as it fits.
 *
 * The thresholds are MEASURED in a real engine, not estimated. Because the readout now owns its own
 * line it is measured against the FULL content box rather than against whatever the actions leave
 * over, which is why its words survive so much further down than they used to.
 */
export const HIDE_MODEL_TEXT = '@max-[18rem]:sr-only';
export const HIDE_PILL_TEXT = '@max-[14rem]:sr-only';
/** Floor: below this even three glyph chips cannot share their line, so the context strip goes. */
export const HIDE_CONTEXT_PILLS = '@max-[11rem]:sr-only';
/** Not exported: StripAction below is the only thing that sheds an action label. */
const HIDE_ACTION_TEXT = '@max-[22rem]:sr-only';

export function FlowSurfaceCard({
  meta,
  status,
  aside,
  actions,
  children,
}: {
  /** The readout chips. Renders null in the taskless windows between nodes, and the line it sits on
   *  collapses with it rather than leaving 24px of empty card. */
  meta: ReactNode;
  /** Spinner plus ONE truncating sentence. The card supplies its type and colour; pass a bare span
   *  carrying `min-w-0 flex-1` and let its inner label carry `truncate`. */
  status: ReactNode;
  /** Controls that may come and go, placed before the pinned group so that their unmounting can
   *  never move the terminal action. The note toggle lives here. */
  aside?: ReactNode;
  /** The run controls. The LAST is always the terminal action; the card pins it. */
  actions: ReactNode;
  /** The note field (running, only while open) or the reply box (paused, always). */
  children?: ReactNode;
}) {
  return (
    <div className="relative z-20 min-w-0 px-2 pb-2">
      <div className="@container mx-auto w-full max-w-2xl">
        <div className={`flex w-full flex-col gap-2 ${agentsChatComposerShellClass(false, false)}`}>
          {/* Context and the live line are ONE block, 6px apart, because the chips annotate the
              sentence rather than opening a separate stanza. The shell's own 8px then separates that
              block from the input, so the rhythm reads 6 / 8 instead of a flat stack of equal rows. */}
          <div className="flex min-w-0 flex-col gap-1.5">
            {/* `empty:hidden` is load-bearing, not defensive: FlowRunMeta returns null in a taskless
                window, and without this the row would still be a flex item and still take its 6px
                gap, leaving a visible dead band above the status on every such card. */}
            <div className="flex min-w-0 items-center overflow-hidden empty:hidden">{meta}</div>
            <div className="flex items-center gap-3">
              {/* Why the sentence can never paint over the controls, as geometry rather than as a
                  list of class names: this row has at most three in-flow children, and this is the
                  ONLY flexible one (`min-w-0 flex-1`, so it absorbs every pixel of shrink; the
                  default `min-width: auto` would refuse to shrink at all). Everything to its right is
                  `shrink-0` and is therefore never compressed into, and `truncate` clips this one.
                  No negative margins, no absolute positioning, so overlap is geometrically
                  impossible and the tiers only decide how early the ellipsis appears. */}
              <div className="flex min-w-0 flex-1 items-center gap-2 truncate text-xs font-medium text-foreground">
                {status}
              </div>
              {aside}
              {/* Pinned: the terminal action is the LAST child of a right-anchored group that never
                  wraps or re-stacks, so its right edge is the row's right edge no matter what sits
                  before it. Pause unmounting across a node transition, the note toggle disappearing
                  when its field opens, and the input opening below all leave Stop exactly where the
                  cursor left it. Anything that comes and goes belongs in `aside`, never in here. */}
              <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>
            </div>
          </div>
          {/* Bare, with no rule or padding of its own: the shell's gap-2 already separates reading
              from typing, and a hairline plus its padding would cost 17px on every paused pane and
              every open note to carry one pixel of information. An absent child contributes neither
              a flex item nor a gap, so the running card stays two lines by itself. */}
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * The action row's button shape. The label is a real text node that becomes `sr-only` when the card
 * is narrow, so it is the accessible name at EVERY width, with no parallel `aria-label` to drift out
 * of sync with what sighted users read. `title` carries the longer explanation for the mouse.
 *
 * Note for anyone unifying buttons later: StopRunButton's "Confirm stop" and "Keep running" are raw
 * `Button`s on purpose, NOT StripActions, so they can never inherit HIDE_ACTION_TEXT. A destructive
 * confirm that shed to a glyph would be a trap, and an X beside "Confirm stop" reads as "cancel the
 * run". Porting them onto this component would silently glyph them.
 */
export function StripAction({
  label,
  title,
  icon,
  variant = 'ghost',
  disabled,
  onClick,
  buttonRef,
  offscreen = false,
  ...aria
}: {
  label: string;
  title: string;
  icon: ReactNode;
  variant?: 'ghost' | 'secondary';
  disabled?: boolean;
  onClick: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
  /**
   * Takes the button out of the row's flow without unmounting it: `sr-only` is absolutely
   * positioned, so it frees the width, and unlike `hidden` it leaves the button focusable. That
   * matters wherever something hands focus back to a control that is currently out of the way.
   */
  offscreen?: boolean;
  'aria-expanded'?: boolean;
  'aria-controls'?: string;
}) {
  return (
    <Button
      ref={buttonRef}
      type="button"
      size="sm"
      variant={variant}
      className={`h-7 shrink-0 gap-1 text-xs${variant === 'ghost' ? ' text-muted-foreground' : ''}${offscreen ? ' sr-only' : ''}`}
      disabled={disabled}
      onClick={onClick}
      title={title}
      {...aria}
    >
      {icon}
      <span className={HIDE_ACTION_TEXT}>{label}</span>
    </Button>
  );
}
