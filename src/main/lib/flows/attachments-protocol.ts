/**
 * Custom protocol handler for `frink-attachment://<runId>/<filename>`.
 *
 * Renderer code (FlowEditor.BatchMonitor.RunAttachmentsSection) consumes
 * `RunAttachment.url`. Cloud returned a Vercel blob proxy URL; locally we hand
 * back `frink-attachment://...` and resolve via this handler so `<img src>`
 * works without a data-URL round-trip through the renderer.
 *
 * Mime type inferred from extension (png/jpeg/webp covers the only allowed
 * upload types — see ALLOWED_ATTACHMENT_MIME_TYPES in shared/run-attachment).
 */

import { protocol } from 'electron';
import log from 'electron-log';
import {
  ATTACHMENT_PROTOCOL,
  AttachmentPathError,
  attachmentMimeType,
  readAttachment,
} from './attachments-storage';

const LEADING_SLASH_RE = /^\//;

/**
 * Register the scheme as privileged BEFORE `app.whenReady()`. Tells Electron
 * the scheme is `secure` + `standard` so the renderer's CSP `'self'` and
 * fetch/img loads work. Without this, CSP blocks `<img src="frink-attachment://...">`.
 */
export function registerAttachmentSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ATTACHMENT_PROTOCOL,
      privileges: {
        secure: true,
        standard: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false,
      },
    },
  ]);
}

/**
 * Register the protocol handler. Must be called after `app.whenReady()`.
 * Idempotent — calling twice unregisters and re-registers.
 */
export function registerAttachmentProtocol(): void {
  if (protocol.isProtocolHandled(ATTACHMENT_PROTOCOL)) {
    protocol.unhandle(ATTACHMENT_PROTOCOL);
  }
  protocol.handle(ATTACHMENT_PROTOCOL, async (req) => {
    try {
      const url = new URL(req.url);
      // frink-attachment://<runId>/<filename>
      const runId = url.hostname;
      const filename = url.pathname.replace(LEADING_SLASH_RE, '');
      const buffer = await readAttachment(runId, filename);
      const body = new Uint8Array(buffer);
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': attachmentMimeType(filename) },
      });
    } catch (err) {
      const status = err instanceof AttachmentPathError ? 400 : 404;
      log.warn('[FlowsAttachments] protocol handle error', {
        url: req.url,
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response(`Attachment unavailable`, { status });
    }
  });
}
