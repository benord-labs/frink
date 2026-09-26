/**
 * http_request block — render URL/headers/body templates, run SSRF guard,
 * issue fetch, normalize the response into NodeOutput.outputs.
 *
 * SSRF guarding reuses the ported http-request-url-guard module (DNS resolve +
 * private-range rejection). Body / headers / response capped at the same byte
 * limits as the cloud engine so flows behave the same way.
 */

import { captureMainMessage } from '../../sentry/init';
import { buildVariables } from '../block-context';
import {
  assertHttpRequestUrlSafe,
  HTTP_REQUEST_MAX_BODY_UTF8_BYTES,
  HTTP_REQUEST_MAX_HEADERS_JSON_BYTES,
  HTTP_REQUEST_MAX_URL_LENGTH,
} from '../http-request-url-guard';
import { findUnsafeUrlPlaceholder, renderTemplate } from '../template-utils';
import type { Dispatcher } from './types';

type HttpRequestConfig = {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_HTTP_RESPONSE_CHARS = 256 * 1024;

/** RFC 7230 token characters for header field-name. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Header value must not contain CR / LF / NUL — RFC 7230 + SP-Header injection guard. */
const HEADER_VALUE_FORBIDDEN_RE = /[\r\n\0]/;

async function readBodyCapped(
  res: Response,
  maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
  if (res.body == null) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value && value.byteLength > 0) {
        const chunk = decoder.decode(value, { stream: true });
        const space = maxChars - text.length;
        if (chunk.length > space) {
          text += chunk.slice(0, space);
          truncated = true;
          await reader.cancel('size limit').catch(() => {});
          break;
        }
        text += chunk;
      }
      if (done) {
        const tail = decoder.decode();
        if (tail.length > 0) {
          const space = maxChars - text.length;
          if (tail.length > space) {
            text += tail.slice(0, space);
            truncated = true;
          } else {
            text += tail;
          }
        }
        break;
      }
      if (text.length >= maxChars) {
        truncated = true;
        await reader.cancel('size limit').catch(() => {});
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { text, truncated };
}

export const dispatchHttpRequest: Dispatcher = async (ctx) => {
  const config = (ctx.node.config ?? {}) as HttpRequestConfig;
  const variables = buildVariables({
    triggerContext: ctx.triggerContext,
    previousOutput: ctx.previousOutput,
    loopContext: ctx.loopContext,
  });

  // A url routes the request: a missing value anywhere, or a blank one in the path, would retarget it
  // (items/{{previous.id}} collapses to the whole items/ collection). Blank query values stay allowed.
  const unsafe = findUnsafeUrlPlaceholder(config.url ?? '', variables);
  if (unsafe) {
    captureMainMessage('Flow http_request refused an unsafe url placeholder', 'warning', {
      surface: 'flow-http-request',
      reason: 'unsafe-url-placeholder',
    });
    return {
      type: 'error',
      message: `http_request url placeholder ${unsafe} is missing or blank, so the request was not sent`,
    };
  }
  const url = renderTemplate(config.url ?? '', variables).trim();
  if (!url) return { type: 'error', message: 'http_request missing url' };
  if (url.length > HTTP_REQUEST_MAX_URL_LENGTH) {
    return { type: 'error', message: 'http_request url too long' };
  }

  const method = (config.method ?? 'GET').toUpperCase();
  if (!HTTP_METHODS.has(method)) {
    return { type: 'error', message: `http_request unsupported method ${method}` };
  }

  const guard = await assertHttpRequestUrlSafe(url);
  if (!guard.ok) return { type: 'error', message: guard.message };

  const headers: Record<string, string> = {};
  if (config.headers && typeof config.headers === 'object') {
    for (const [k, v] of Object.entries(config.headers)) {
      if (!HEADER_NAME_RE.test(k)) {
        return { type: 'error', message: `http_request invalid header name: ${k}` };
      }
      const rendered = typeof v === 'string' ? renderTemplate(v, variables) : '';
      // Reject CR/LF/NUL in rendered values — prevents header / response splitting via
      // attacker-controlled trigger context fields.
      if (HEADER_VALUE_FORBIDDEN_RE.test(rendered)) {
        return {
          type: 'error',
          message: `http_request header "${k}" contains forbidden characters (CR/LF/NUL)`,
        };
      }
      headers[k] = rendered;
    }
    if (JSON.stringify(headers).length > HTTP_REQUEST_MAX_HEADERS_JSON_BYTES) {
      return { type: 'error', message: 'http_request headers too large' };
    }
  }

  let body: string | undefined;
  if (method !== 'GET' && config.body !== undefined) {
    body = renderTemplate(config.body, variables);
    if (Buffer.byteLength(body, 'utf8') > HTTP_REQUEST_MAX_BODY_UTF8_BYTES) {
      return { type: 'error', message: 'http_request body too large' };
    }
  }

  const startedAt = Date.now();
  let res: Response;
  try {
    // redirect: 'manual' — SSRF guard already validated `url` against private-range
    // IPs / blocked hostnames. `redirect: 'follow'` would let an attacker's endpoint
    // redirect to 169.254.169.254 (AWS IMDS) or 192.168.x bypassing the guard. We
    // surface 3xx as a normal response with empty body so users can inspect Location
    // explicitly if they need redirect-following behaviour.
    res = await fetch(url, { method, headers, body, signal: ctx.signal, redirect: 'manual' });
  } catch (err) {
    if (ctx.signal.aborted) {
      return {
        type: 'completed',
        output: {
          status: 'cancelled',
          outputs: { url, method },
          artifacts: [],
          durationMs: Date.now() - startedAt,
        },
      };
    }
    return {
      type: 'completed',
      output: {
        status: 'failed',
        outputs: { url, method },
        artifacts: [],
        durationMs: Date.now() - startedAt,
        error: { message: err instanceof Error ? err.message : 'fetch failed', retryable: true },
      },
    };
  }

  const { text, truncated } = await readBodyCapped(res, MAX_HTTP_RESPONSE_CHARS);
  // Surface response headers — `output-schemas.ts` declares them guaranteed,
  // so downstream condition/template nodes break with `undefined` if omitted.
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  return {
    type: 'completed',
    output: {
      status: res.ok ? 'completed' : 'failed',
      outputs: {
        url,
        method,
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
        body: text,
        truncated,
      },
      artifacts: [],
      durationMs: Date.now() - startedAt,
    },
  };
};
