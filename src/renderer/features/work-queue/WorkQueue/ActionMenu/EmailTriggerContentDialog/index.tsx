import DOMPurify from 'isomorphic-dompurify';
import type { ReactElement } from 'react';
import type { TriggerContext } from '../../../../../../shared/types/trigger-context';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../../../components/ui/tabs';
import { asGmailFullContent } from '../../../utils/trigger-context';
import { TriggerDialogShell } from '../TriggerDialogShell';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerContext: TriggerContext;
};

const HTML_TAG_REGEX = /<\/?[a-z][\s\S]*>/i;

function renderMeta(
  label: string,
  value: string | number | boolean | null | undefined,
): ReactElement | null {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="space-y-1">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm text-foreground wrap-break-word">{String(value)}</p>
    </div>
  );
}

export function EmailTriggerContentDialog({
  open,
  onOpenChange,
  triggerContext,
}: Props): ReactElement {
  const gmailContent = asGmailFullContent(triggerContext);
  // Defensive guard: TriggerContentDialog routes only Gmail sources here.
  if (!gmailContent) {
    const payload = JSON.stringify(triggerContext.fullContent ?? {}, null, 2);
    return (
      <TriggerDialogShell open={open} onOpenChange={onOpenChange} title="Original Email">
        <div className="space-y-1">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Payload</p>
          <pre className="text-xs text-foreground whitespace-pre-wrap wrap-break-word bg-muted/50 border border-border rounded-md p-3">
            {payload}
          </pre>
        </div>
      </TriggerDialogShell>
    );
  }
  const htmlBody = gmailContent?.body?.trim() ?? '';
  const hasHtmlBody = HTML_TAG_REGEX.test(htmlBody);
  const plainBody = gmailContent?.bodyPlain?.trim() || htmlBody || 'No body content available.';
  const sanitizedHtml = hasHtmlBody ? DOMPurify.sanitize(htmlBody) : '';
  const emailHtmlDocument = hasHtmlBody
    ? `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.55; color: #e5e7eb; background: #0f1115; margin: 0; padding: 16px; }
    a { color: #60a5fa; word-break: break-word; }
    img { max-width: 100%; height: auto; }
    pre, code { white-space: pre-wrap; word-break: break-word; }
    blockquote { border-left: 3px solid #374151; margin: 0; padding-left: 12px; color: #9ca3af; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #374151; padding: 6px; text-align: left; }
  </style>
</head>
<body>${sanitizedHtml}</body>
</html>`
    : '';
  return (
    <TriggerDialogShell open={open} onOpenChange={onOpenChange} title="Original Email">
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {renderMeta('From', gmailContent.from)}
          {renderMeta('To', gmailContent.to)}
          {renderMeta('Subject', gmailContent.subject)}
          {renderMeta('Received', gmailContent.receivedAt)}
          {renderMeta('Attachments', gmailContent.hasAttachments ? 'Yes' : 'No')}
          {renderMeta('Thread messages', gmailContent.threadMessageCount)}
        </div>
        {Array.isArray(gmailContent.labels) &&
          gmailContent.labels.length > 0 &&
          renderMeta('Labels', gmailContent.labels.join(', '))}
        <div className="space-y-1">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Body</p>
          {hasHtmlBody ? (
            <Tabs defaultValue="rendered" className="w-full">
              <TabsList className="h-8">
                <TabsTrigger value="rendered" className="text-xs px-2.5 py-1">
                  Rendered
                </TabsTrigger>
                <TabsTrigger value="plain" className="text-xs px-2.5 py-1">
                  Plain text
                </TabsTrigger>
              </TabsList>
              <TabsContent value="rendered" className="mt-2">
                <iframe
                  title="Rendered email"
                  sandbox=""
                  srcDoc={emailHtmlDocument}
                  className="w-full h-[48vh] min-h-[360px] rounded-md border border-border bg-background"
                />
              </TabsContent>
              <TabsContent value="plain" className="mt-2">
                <div className="text-sm leading-6 text-foreground whitespace-pre-wrap wrap-break-word bg-muted/40 border border-border rounded-md p-3 max-h-[420px] overflow-y-auto">
                  {plainBody}
                </div>
              </TabsContent>
            </Tabs>
          ) : (
            <div className="text-sm leading-6 text-foreground whitespace-pre-wrap wrap-break-word bg-muted/40 border border-border rounded-md p-3 max-h-[420px] overflow-y-auto">
              {plainBody}
            </div>
          )}
        </div>
      </div>
    </TriggerDialogShell>
  );
}
