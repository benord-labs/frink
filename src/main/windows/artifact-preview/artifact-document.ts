import type { ArtifactPreviewOpenRequest } from '../../../shared/types/artifacts/html-artifact';

const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  "media-src 'none'",
  'font-src data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "webrtc 'block'",
].join('; ');

const LOCKED_GLOBALS =
  'RTCPeerConnection webkitRTCPeerConnection mozRTCPeerConnection localStorage sessionStorage indexedDB caches Worker SharedWorker BroadcastChannel'.split(
    ' ',
  );
const ARTIFACT_LOCKDOWN_SCRIPT = `(() => {
  'use strict';
  const disable = (target, name) => {
    try {
      Object.defineProperty(target, name, {
        value: undefined,
        writable: false,
        configurable: false,
      });
    } catch {}
  };
  for (const name of ${JSON.stringify(LOCKED_GLOBALS)}) disable(globalThis, name);
  disable(navigator, 'serviceWorker');
})();`;

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function artifactDataUrl(request: ArtifactPreviewOpenRequest): string {
  const document = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(request.artifact.title)}</title><script>${ARTIFACT_LOCKDOWN_SCRIPT}</script></head><body>${request.artifact.bodyHtml}</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(document)}`;
}
