/**
 * HTTP Request block configuration.
 */

import { Input, Textarea } from '@benord-labs/frink-primitives';
import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { FlowNode } from '../../../../../../shared/lib/validate-flow-graph';
import type { HttpRequestMethod } from '../../../../../../shared/types/flow';
import { Label } from '../../../../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../../components/ui/select';
import { cfg, FieldRow } from '../shared';

const METHODS: HttpRequestMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

type Props = {
  node: FlowNode;
  onPatchLabel: (patch: { label?: string }) => void;
  onConfigPatch: (config: Record<string, unknown>) => void;
};

function headersToText(c: Record<string, unknown>): string {
  const h = c.headers;
  if (h !== undefined && typeof h === 'object' && h !== null && !Array.isArray(h)) {
    try {
      return JSON.stringify(h, null, 2);
    } catch {
      return '';
    }
  }
  return '';
}

export function HttpRequestConfig({ node, onPatchLabel, onConfigPatch }: Props): ReactElement {
  const c = cfg(node);
  const url = typeof c.url === 'string' ? c.url : '';
  const method = (typeof c.method === 'string' ? c.method : 'GET') as HttpRequestMethod;
  const body = typeof c.body === 'string' ? c.body : '';

  const [headersText, setHeadersText] = useState(() => headersToText(c));
  const [headersError, setHeadersError] = useState<string | null>(null);

  // Avoid depending on `node.config` (new object reference each graph update); resync only when
  // the selected node or the headers payload reference changes.
  const headersTextFromNode = useMemo(() => headersToText(c), [c.headers]);
  useEffect(() => {
    setHeadersText(headersTextFromNode);
    setHeadersError(null);
  }, [node.id, headersTextFromNode]);

  const urlErr = url.trim() === '' ? 'URL is required.' : null;

  const applyHeadersFromText = (raw: string): void => {
    setHeadersText(raw);
    const t = raw.trim();
    if (t === '') {
      setHeadersError(null);
      onConfigPatch({ headers: undefined });
      return;
    }
    try {
      const parsed: unknown = JSON.parse(t);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setHeadersError('Headers must be a JSON object (not an array).');
        return;
      }
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        flat[k] =
          typeof v === 'string'
            ? v
            : v === null || v === undefined
              ? ''
              : typeof v === 'object'
                ? JSON.stringify(v)
                : String(v);
      }
      setHeadersError(null);
      onConfigPatch({ headers: flat });
    } catch {
      setHeadersError('Invalid JSON.');
    }
  };

  return (
    <div className="space-y-4">
      <FieldRow
        htmlFor="flow-http-request-label"
        label="Display name"
        hint="Shown in the step list."
      >
        <Input
          id="flow-http-request-label"
          value={node.label ?? ''}
          onChange={(e) => onPatchLabel({ label: e.target.value })}
          placeholder="HTTP request"
        />
      </FieldRow>
      <FieldRow htmlFor="flow-http-url" label="URL" error={urlErr}>
        <Input
          id="flow-http-url"
          value={url}
          onChange={(e) => onConfigPatch({ url: e.target.value })}
          placeholder="https://api.example.com/v1/status"
          error={!!urlErr}
        />
      </FieldRow>
      <div className="space-y-2">
        <Label htmlFor="flow-http-method">Method</Label>
        <Select
          value={METHODS.includes(method) ? method : 'GET'}
          onValueChange={(v) => {
            const nextMethod = v as HttpRequestMethod;
            const patch: Record<string, unknown> = { method: nextMethod };
            if (typeof c.body === 'string') {
              patch.body = c.body;
            }
            onConfigPatch(patch);
          }}
        >
          <SelectTrigger id="flow-http-method">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {METHODS.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <FieldRow
        htmlFor="flow-http-headers"
        label="Headers (JSON)"
        hint='JSON object of header names to values; non-strings are coerced to strings for the request. Example: {"Accept":"application/json"}'
        error={headersError}
      >
        <Textarea
          id="flow-http-headers"
          value={headersText}
          onChange={(e) => applyHeadersFromText(e.target.value)}
          placeholder='{ "Accept": "application/json" }'
          rows={4}
          className={`font-mono text-xs ${headersError ? 'border-destructive' : ''}`}
        />
      </FieldRow>
      {/* Keep mounted so config.body stays bound; hide for GET/DELETE (UI only). */}
      <div className={method === 'GET' || method === 'DELETE' ? 'hidden' : undefined}>
        <FieldRow
          htmlFor="flow-http-body"
          label="Body"
          hint="For JSON APIs, set Content-Type in headers or the server defaults to application/json when a body is sent."
          error={null}
        >
          <Textarea
            id="flow-http-body"
            value={body}
            onChange={(e) => onConfigPatch({ body: e.target.value })}
            placeholder="Request body"
            rows={6}
            className="font-mono text-xs"
          />
        </FieldRow>
      </div>
    </div>
  );
}
