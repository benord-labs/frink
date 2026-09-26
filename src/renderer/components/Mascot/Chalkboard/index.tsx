import { type CSSProperties, type Ref, useId, useImperativeHandle, useRef } from 'react';
import {
  ANSWER_INDEX,
  BOARD_FRAME,
  BOARD_OUTER,
  BOARD_PAINT,
  BOARD_VIEWBOX,
  type BoardLine,
  ringPath,
} from '@/lib/mascot/chalkboard-geometry';
import type { ChalkboardControls } from '@/lib/mascot/summon-choreography';
import { easeOut, tween } from '@/lib/mascot/timeline';

type Point = { x: number; y: number };

/** Slow enough to read along as Frink writes. */
const WRITE_PX_PER_SECOND = 120;

/** Replaces any running animation on `el`, so a later exit always wins over an earlier entrance. */
function play(el: Element | null, frames: Keyframe[], ms: number): Promise<void> {
  if (!el?.animate) return Promise.resolve();
  for (const running of el.getAnimations?.() ?? []) running.cancel();
  return el
    .animate(frames, { duration: ms, fill: 'forwards', easing: 'cubic-bezier(.2,.8,.3,1)' })
    .finished.then(
      () => undefined,
      () => undefined,
    );
}

/** happy-dom and some fonts lack SVG text metrics; estimate from the glyph count. */
function textWidth(text: SVGTextElement, size: number): number {
  return text.getComputedTextLength?.() || (text.textContent?.length ?? 0) * size * 0.55;
}

type ChalkboardProps = {
  ref: Ref<ChalkboardControls>;
  style: CSSProperties;
  lines: readonly BoardLine[];
};

export function Chalkboard({ ref, style, lines }: ChalkboardProps) {
  const uid = useId().replace(/:/g, '');
  const boardRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const linesRef = useRef<SVGGElement>(null);
  const ringRef = useRef<SVGPathElement>(null);
  const tipRef = useRef<SVGCircleElement>(null);
  const clipRefs = useRef<Array<SVGRectElement | null>>([]);
  const textRefs = useRef<Array<SVGTextElement | null>>([]);

  // Measured once per stroke or grain batch: the board never moves mid-write, and
  // reading layout inside the animation frame would force a reflow every frame.
  const viewportMapper = () => {
    const r = svgRef.current?.getBoundingClientRect();
    return (x: number, y: number): Point =>
      r
        ? {
            x: r.left + ((x + BOARD_FRAME) * r.width) / BOARD_OUTER.width,
            y: r.top + ((y + BOARD_FRAME) * r.height) / BOARD_OUTER.height,
          }
        : { x, y };
  };

  useImperativeHandle(ref, () => ({
    async unroll(_token, reducedMotion) {
      boardRef.current?.classList.replace('invisible', 'visible');
      await (reducedMotion
        ? play(boardRef.current, [{ opacity: 0 }, { opacity: 1 }], 300)
        : play(
            boardRef.current,
            [
              { transform: 'scaleY(0.02)', opacity: 0.4 },
              { transform: 'scaleY(1.03)', opacity: 1, offset: 0.8 },
              { transform: 'scaleY(1)', opacity: 1 },
            ],
            520,
          ));
    },
    async write(index, token, onTip) {
      const line = lines[index];
      const text = textRefs.current[index];
      const clip = clipRefs.current[index];
      const tip = tipRef.current;
      if (!line || !text || !clip) return;
      const width = textWidth(text, line.size) + 6;
      const toViewport = viewportMapper();
      tip?.setAttribute('opacity', '1');
      try {
        await tween((width / WRITE_PX_PER_SECOND) * 1000, token, (p) => {
          const x = line.x + width * p;
          const y = line.y - line.size * 0.32 + Math.sin(p * width * 0.22) * line.size * 0.28;
          clip.setAttribute('width', String(x));
          tip?.setAttribute('cx', String(x));
          tip?.setAttribute('cy', String(y));
          onTip(toViewport(x, y));
        });
      } finally {
        tip?.setAttribute('opacity', '0');
      }
    },
    reveal(count) {
      for (const clip of clipRefs.current.slice(0, count)) {
        clip?.setAttribute('width', String(BOARD_VIEWBOX.width));
      }
    },
    async circleAnswer(token, reducedMotion) {
      const ring = ringRef.current;
      const answer = textRefs.current[ANSWER_INDEX];
      if (!ring || !answer?.getBBox) return;
      ring.setAttribute('d', ringPath(answer.getBBox()));
      const length = ring.getTotalLength?.() ?? 0;
      ring.style.strokeDasharray = String(length);
      if (reducedMotion) {
        ring.style.strokeDashoffset = '0';
        return;
      }
      await tween(650, token, (p) => {
        ring.style.strokeDashoffset = String(length * (1 - easeOut(p)));
      });
    },
    rollUp() {
      void play(linesRef.current, [{ opacity: 1 }, { opacity: 0 }], 700);
      void play(ringRef.current, [{ opacity: 1 }, { opacity: 0 }], 700);
      void play(
        boardRef.current,
        [
          { transform: 'scaleY(1)', opacity: 1 },
          { transform: 'scaleY(0.02)', opacity: 0 },
        ],
        420,
      );
    },
    fadeOut() {
      void play(boardRef.current, [{ opacity: 1 }, { opacity: 0 }], 300);
    },
  }));

  const { width: W, height: H } = BOARD_OUTER;
  const slateH = BOARD_VIEWBOX.height + 2 * BOARD_FRAME;
  return (
    <div
      ref={boardRef}
      className="invisible absolute origin-top drop-shadow-2xl"
      style={style}
      aria-hidden
    >
      <svg ref={svgRef} className="block h-auto w-full" viewBox={`0 0 ${W} ${H}`}>
        <defs>
          <filter id={`${uid}-chalk`} x="-5%" y="-25%" width="110%" height="150%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="1.3"
              numOctaves={2}
              seed={7}
              result="n"
            />
            <feColorMatrix
              in="n"
              type="matrix"
              values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  2.6 0 0 0 -0.75"
              result="grain"
            />
            <feComposite in="SourceGraphic" in2="grain" operator="in" result="g" />
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.05"
              numOctaves={1}
              seed={2}
              result="w"
            />
            <feDisplacementMap in="g" in2="w" scale={1.8} />
          </filter>
          <radialGradient id={`${uid}-sheen`} cx="30%" cy="35%" r="60%">
            <stop offset="0" stopColor={BOARD_PAINT.chalk} stopOpacity={0.06} />
            <stop offset="1" stopColor={BOARD_PAINT.chalk} stopOpacity={0} />
          </radialGradient>
          {lines.map((line, i) => (
            <clipPath key={i} id={`${uid}-clip${i}`}>
              <rect
                ref={(el) => {
                  clipRefs.current[i] = el;
                }}
                x={0}
                y={line.y - 40}
                width={0}
                height={60}
              />
            </clipPath>
          ))}
        </defs>
        <rect width={W} height={slateH} rx={4} fill={BOARD_PAINT.wood} />
        <rect
          x={BOARD_FRAME}
          y={BOARD_FRAME}
          width={BOARD_VIEWBOX.width}
          height={BOARD_VIEWBOX.height}
          fill={BOARD_PAINT.slate}
        />
        <rect
          x={BOARD_FRAME}
          y={BOARD_FRAME}
          width={BOARD_VIEWBOX.width}
          height={BOARD_VIEWBOX.height}
          fill={`url(#${uid}-sheen)`}
        />
        <rect y={slateH} width={W} height={7} rx={2} fill={BOARD_PAINT.woodDark} />
        <rect x={W - 44} y={slateH + 2} width={18} height={4} rx={1} fill={BOARD_PAINT.chalk} />
        <rect x={30} y={slateH} width={30} height={6} rx={1} fill={BOARD_PAINT.eraser} />
        <rect x={30} y={slateH} width={30} height={2} fill={BOARD_PAINT.felt} />
        <g transform={`translate(${BOARD_FRAME} ${BOARD_FRAME})`}>
          <g ref={linesRef} filter={`url(#${uid}-chalk)`}>
            {lines.map((line, i) => (
              <text
                key={i}
                ref={(el) => {
                  textRefs.current[i] = el;
                }}
                className="font-playwrite font-light"
                fill={BOARD_PAINT.chalk}
                x={line.x}
                y={line.y}
                fontSize={line.size}
                clipPath={`url(#${uid}-clip${i})`}
                transform={`rotate(${i % 2 ? -0.6 : 0.5} 212 ${line.y})`}
              >
                {line.text}
              </text>
            ))}
          </g>
          <path
            ref={ringRef}
            filter={`url(#${uid}-chalk)`}
            d=""
            fill="none"
            stroke={BOARD_PAINT.chalk}
            strokeWidth={2.4}
            strokeLinecap="round"
          />
          <circle ref={tipRef} r={2.6} opacity={0} fill={BOARD_PAINT.chalk} />
        </g>
      </svg>
    </div>
  );
}
