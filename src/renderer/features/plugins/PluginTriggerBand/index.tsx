/** Up to five slides: a supported trigger, a Flow action, then general examples. */
import { Button, TileSurface } from '@benord-labs/frink-primitives';
import { ArrowRight, ChevronLeft, ChevronRight, Zap } from 'lucide-react';
import { useState } from 'react';
import { bandSummary, type ChainStepData } from '../../../lib/plugins/plugin-detail-model';
import { ChainStep, HERO_DIM, HERO_INK } from '../PluginsHero';
import { BandMaterial } from './BandMaterial';

type Props = {
  pluginName: string;
  chain: [ChainStepData, ChainStepData] | null;
  triggerCount: number;
  /** Tools + actions in the package — the band must not read as triggers-only. */
  agentToolCount?: number;
  /** The package ships an MCP, so its tools also reach agents in everyday chats. */
  chatToolsAvailable?: boolean;
  /** Absent when no route exists (gated provider, no account) — the button never dead-ends. */
  onUseInFlow?: (triggerId: string) => void;
  /** Example prompts for this provider; absent/empty hides the prompt slides entirely. */
  prompts?: readonly string[];
  /** Seeds the chat composer with a clicked prompt (or routes to Connect when locked). */
  onUsePrompt?: (prompt: string) => void;
  /** No live account yet: the caption and labels say Connect comes first, so nothing over-promises. */
  promptsLocked?: boolean;
};

type Slide = { kind: 'flow' } | { kind: 'prompt'; prompt: string };

export function PluginTriggerBand({
  pluginName,
  chain,
  triggerCount,
  agentToolCount = 0,
  chatToolsAvailable = false,
  onUseInFlow,
  prompts = [],
  onUsePrompt,
  promptsLocked = false,
}: Props) {
  const [active, setActive] = useState(0);

  const [start, end] = chain ?? [];
  // Only a trigger chain can prefill a webhook trigger; the tool chain has no event.
  const useInFlowTriggerId = onUseInFlow ? start?.triggerId : undefined;
  const example = bandSummary(triggerCount, agentToolCount, chatToolsAvailable);

  const slides: Slide[] = [
    ...(chain ? [{ kind: 'flow' } as const] : []),
    ...prompts.slice(0, chain ? 4 : 5).map((prompt) => ({ kind: 'prompt', prompt }) as const),
  ];
  // The package prompt list can shrink while a later slide is
  // active; clamping keeps the pager on a slide that still exists.
  const index = Math.min(active, slides.length - 1);
  if (slides.length === 0) return null;

  return (
    <section
      aria-label={`What ${pluginName} can start${example ? `, ${example}` : ''}`}
      className="mt-8"
    >
      <TileSurface
        corner={<Zap className="size-3.5" style={{ color: HERO_DIM }} aria-hidden />}
        contentClassName="relative gap-0 p-0"
      >
        <BandMaterial />
        <div className="relative z-10 flex flex-col gap-4 px-7 pt-6 pb-5">
          <div className="overflow-hidden">
            <div
              className="flex transition-transform duration-300 ease-out motion-reduce:transition-none"
              style={{ transform: `translateX(-${index * 100}%)` }}
            >
              {slides.map((slide, slideIndex) => (
                <div
                  key={slide.kind === 'prompt' ? slide.prompt : 'flow'}
                  className="flex min-h-[10rem] w-full shrink-0 flex-col items-center justify-center gap-4 px-2"
                  aria-hidden={slideIndex !== index || undefined}
                  inert={slideIndex !== index || undefined}
                >
                  {slide.kind === 'flow' ? (
                    <FlowSlide
                      pluginName={pluginName}
                      start={start}
                      end={end}
                      onUseInFlow={onUseInFlow}
                      useInFlowTriggerId={useInFlowTriggerId}
                    />
                  ) : (
                    <PromptSlide
                      pluginName={pluginName}
                      prompt={slide.prompt}
                      promptsLocked={promptsLocked}
                      onUsePrompt={onUsePrompt}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>

          {slides.length > 1 ? (
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                aria-label="Previous slide"
                onClick={() =>
                  setActive(
                    (current) =>
                      (Math.min(current, slides.length - 1) - 1 + slides.length) % slides.length,
                  )
                }
                className="flex size-7 items-center justify-center rounded-full border border-border glass-card text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-ring focus-visible:ring-offset-background motion-reduce:transition-none"
              >
                <ChevronLeft className="size-4" aria-hidden />
              </button>
              <div className="flex items-center gap-1.5">
                {slides.map((slide, slideIndex) => (
                  <button
                    key={slide.kind === 'prompt' ? slide.prompt : 'flow'}
                    type="button"
                    aria-label={`Show slide ${slideIndex + 1} of ${slides.length}`}
                    onClick={() => setActive(slideIndex)}
                    className="flex h-5 items-center px-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-ring focus-visible:ring-offset-background"
                  >
                    <span
                      className="h-1 rounded-full transition-colors motion-reduce:transition-none"
                      style={{
                        width: slideIndex === index ? '1.25rem' : '0.375rem',
                        background:
                          slideIndex === index ? HERO_INK : 'hsl(var(--muted-foreground) / 0.35)',
                      }}
                    />
                  </button>
                ))}
              </div>
              <button
                type="button"
                aria-label="Next slide"
                onClick={() =>
                  setActive((current) => (Math.min(current, slides.length - 1) + 1) % slides.length)
                }
                className="flex size-7 items-center justify-center rounded-full border border-border glass-card text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-ring focus-visible:ring-offset-background motion-reduce:transition-none"
              >
                <ChevronRight className="size-4" aria-hidden />
              </button>
            </div>
          ) : null}
        </div>
      </TileSurface>
    </section>
  );
}

function FlowSlide({
  pluginName,
  start,
  end,
  onUseInFlow,
  useInFlowTriggerId,
}: {
  pluginName: string;
  start?: ChainStepData;
  end?: ChainStepData;
  onUseInFlow?: (triggerId: string) => void;
  useInFlowTriggerId?: string;
}) {
  if (!(start && end)) {
    return (
      <p className="text-sm" style={{ color: HERO_INK }}>
        Nothing in {pluginName} runs on its own yet.
      </p>
    );
  }
  return (
    <>
      <ChainRow start={start} end={end} />
      {onUseInFlow && useInFlowTriggerId ? (
        <Button
          variant="primary"
          size="sm"
          shape="pill"
          onClick={() => onUseInFlow(useInFlowTriggerId)}
        >
          Use in Flow
        </Button>
      ) : null}
    </>
  );
}

function PromptSlide({
  pluginName,
  prompt,
  promptsLocked,
  onUsePrompt,
}: {
  pluginName: string;
  prompt: string;
  promptsLocked: boolean;
  onUsePrompt?: (prompt: string) => void;
}) {
  return (
    <>
      <p className="text-xs" style={{ color: HERO_DIM }}>
        {!onUsePrompt
          ? 'Example prompt'
          : promptsLocked
            ? `Connect ${pluginName} to try this in chat`
            : 'Or just ask in chat'}
      </p>
      <button
        type="button"
        aria-label={
          !onUsePrompt
            ? `Example prompt: ${prompt}`
            : promptsLocked
              ? `Connect ${pluginName} to use this prompt in chat: ${prompt}`
              : `Use this prompt in chat: ${prompt}`
        }
        disabled={!onUsePrompt}
        onClick={() => onUsePrompt?.(prompt)}
        className="group inline-flex max-w-full items-center gap-3 rounded-full border py-2 pr-2.5 pl-4 text-left text-sm border-border glass-card text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-ring focus-visible:ring-offset-background motion-reduce:transition-none"
      >
        <span className="min-w-0 truncate">“{prompt}”</span>
        <span
          className="flex size-6 shrink-0 items-center justify-center rounded-full transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
          style={{ background: 'hsl(var(--muted))' }}
          aria-hidden
        >
          <ArrowRight className="size-3.5" style={{ color: HERO_INK }} />
        </span>
      </button>
    </>
  );
}

function ChainRow({ start, end }: { start: ChainStepData; end: ChainStepData }) {
  return (
    <div className="flex w-full flex-col items-start gap-3 @[32rem]:grid @[32rem]:grid-cols-[1fr_auto_1fr] @[32rem]:items-end @[32rem]:gap-x-4">
      <div className="min-w-0 max-w-full @[32rem]:justify-self-end">
        <ChainStep {...start} />
      </div>
      <ArrowRight
        className="size-4 shrink-0 rotate-90 @[32rem]:mb-3 @[32rem]:rotate-0"
        style={{ color: HERO_DIM }}
        aria-hidden
      />
      <div className="min-w-0 max-w-full @[32rem]:justify-self-start">
        <ChainStep {...end} />
      </div>
    </div>
  );
}
