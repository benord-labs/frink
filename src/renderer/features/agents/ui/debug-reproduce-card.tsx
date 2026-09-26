import { Bug } from 'lucide-react';
import { memo } from 'react';

type ReproduceStep = {
  number: number;
  text: string;
};

const STEP_REGEX = /^\d+[.)]\s*/;

export function parseSteps(content: string): ReproduceStep[] {
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  return lines.map((line, idx) => {
    // Strip leading number + dot/paren (e.g. "1. " or "1) ")
    const cleaned = line.replace(STEP_REGEX, '');
    return { number: idx + 1, text: cleaned };
  });
}

const BORDER_STYLE = { border: '0.5px solid hsl(var(--primary) / 0.3)' } as const;

type DebugReproduceCardProps = {
  content: string;
};

export const DebugReproduceCard = memo(function DebugReproduceCard({
  content,
}: DebugReproduceCardProps) {
  const steps = parseSteps(content);

  if (steps.length === 0) return null;

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 overflow-hidden my-2">
      <div className="flex items-center gap-2 px-2.5 py-2 border-b border-primary/20">
        <Bug className="w-3.5 h-3.5 text-primary shrink-0" />
        <span className="text-xs font-medium text-foreground">Reproduction Steps</span>
      </div>

      <div className="px-2.5 py-1.5">
        {steps.map((step) => (
          <div key={step.number} className="flex items-start gap-2.5 py-1.5">
            <div
              className="w-4 h-4 rounded-full flex items-center justify-center shrink-0 mt-px bg-primary/10 text-primary text-[10px] font-medium"
              style={BORDER_STYLE}
            >
              {step.number}
            </div>
            <span className="text-xs text-foreground/90 leading-relaxed">{step.text}</span>
          </div>
        ))}
      </div>

      <div className="px-2.5 py-2 border-t border-primary/20">
        <p className="text-xs italic text-muted-foreground">
          Try these steps and let me know if the bug reproduces.
        </p>
      </div>
    </div>
  );
});
