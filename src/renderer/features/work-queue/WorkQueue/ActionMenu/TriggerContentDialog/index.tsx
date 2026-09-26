import type { ReactElement } from 'react';
import {
  buildTriggerSummary,
  type TriggerSummary,
} from '../../../../../../shared/lib/trigger-summary';
import type { TriggerContext } from '../../../../../../shared/types/trigger-context';
import { ChatMarkdownRenderer } from '../../../../../components/chat-markdown-renderer';
import {
  TriggerSummaryChanges,
  TriggerSummaryFieldRow,
} from '../../../../../components/TriggerSummaryFields';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../../../components/ui/tabs';
import { TriggerDialogShell } from '../TriggerDialogShell';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerContext: TriggerContext;
};

/** Single provider-agnostic summary card, rendered from {@link buildTriggerSummary}. */
function TriggerSummaryCard({ summary }: { summary: TriggerSummary }): ReactElement {
  return (
    <div className="flex gap-0">
      <div className="flex-1 min-w-0 pr-5 space-y-5">
        <h3 className="text-lg font-semibold text-foreground leading-snug">
          {summary.title ?? summary.provider}
        </h3>
        {summary.description && <ChatMarkdownRenderer content={summary.description} size="sm" />}
        {summary.changes && summary.changes.length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              What changed
            </p>
            <TriggerSummaryChanges changes={summary.changes} />
          </div>
        )}
      </div>

      <div className="w-[260px] shrink-0 border-l border-border pl-5 space-y-0 divide-y divide-border">
        {summary.fields.map((f) => (
          <TriggerSummaryFieldRow
            key={f.label}
            label={f.label}
            value={f.value}
            tone={f.tone}
            href={f.href}
          />
        ))}
      </div>
    </div>
  );
}

export function TriggerContentDialog({ open, onOpenChange, triggerContext }: Props): ReactElement {
  const summary = buildTriggerSummary(triggerContext);
  const title = `Original ${summary.provider} Trigger`;
  const rawPayload = JSON.stringify(triggerContext.fullContent ?? {}, null, 2);

  return (
    <TriggerDialogShell open={open} onOpenChange={onOpenChange} title={title}>
      <Tabs defaultValue="summary" className="w-full">
        <TabsList className="h-8">
          <TabsTrigger value="summary" className="text-xs px-2.5 py-1">
            Summary
          </TabsTrigger>
          <TabsTrigger value="payload" className="text-xs px-2.5 py-1">
            Raw payload
          </TabsTrigger>
        </TabsList>

        <TabsContent value="summary" className="mt-4">
          <TriggerSummaryCard summary={summary} />
        </TabsContent>

        <TabsContent value="payload" className="mt-3">
          <pre className="max-h-[60vh] overflow-y-auto rounded-md border border-border bg-muted/30 p-3 text-xs text-foreground whitespace-pre-wrap wrap-break-word">
            {rawPayload}
          </pre>
        </TabsContent>
      </Tabs>
    </TriggerDialogShell>
  );
}
