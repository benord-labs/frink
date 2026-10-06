import { z } from 'zod';
import { isCustomNodeBlockType } from '../block-registry';
import type { FlowNode } from '../validate-flow-graph';

const TEMPLATE_RENDERED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  run_command: ['command', 'projectId'],
  start_task: ['label', 'branch', 'projectId'],
  agent: ['instructions', 'agentInstructions'],
};

const HTTP_REQUEST_RENDERED_FIELDS: readonly string[] = ['url', 'headers', 'body'];
const TEMPLATE_STRING = z.string();
const HEADER_VALUE = z.string().nullable().catch(null);
/**
 * The runtime iterates any object as headers, an array included (entries named by index), rendering
 * each string value; other values send empty. A string is never sent.
 */
const HTTP_HEADERS = z.union([z.record(z.string(), HEADER_VALUE), z.array(HEADER_VALUE)]);
const HTTP_METHOD = z.string().catch('GET');

/** Fields whose string values are rendered as Flow templates at runtime. */
export function getTemplateRenderedFields(
  blockType: string,
  config: FlowNode['config'],
): readonly string[] {
  if (blockType === 'chat_reply') {
    return config?.contentType === 'html_artifact'
      ? ['artifactTitleTemplate', 'artifactBodyHtmlTemplate']
      : ['messageTemplate'];
  }
  if (blockType === 'http_request') {
    // A string (e.g. stringified JSON) is never sent as headers, so it is not rendered either.
    const headersRender = HTTP_HEADERS.safeParse(config?.headers).success;
    return headersRender ? HTTP_REQUEST_RENDERED_FIELDS : ['url', 'body'];
  }
  const builtInFields = TEMPLATE_RENDERED_FIELDS[blockType];
  if (builtInFields) return builtInFields;
  if (!isCustomNodeBlockType(blockType) || !config) return [];
  // Every top-level key except projectId, which custom-node dispatch reads statically. Callers
  // only ask about values they have already narrowed to strings, so no value check is needed.
  return Object.keys(config).filter((field) => field !== 'projectId');
}

type RenderedString = { field: string; value: string };

/** One entry when the field's value is a string, so it is rendered; none otherwise. */
function renderedString(field: string, config: NonNullable<FlowNode['config']>): RenderedString[] {
  const value = TEMPLATE_STRING.safeParse(config[field]);
  return value.success ? [{ field, value: value.data }] : [];
}

/** Mirrors dispatch/http-request.ts: the url, each string header value, and a non-GET body. */
function httpRequestRenderedStrings(config: NonNullable<FlowNode['config']>): RenderedString[] {
  const headers = HTTP_HEADERS.safeParse(config.headers).data ?? {};
  const headerStrings = Object.entries(headers).flatMap(([name, value]) =>
    value === null ? [] : [{ field: `headers.${name}`, value }],
  );
  const sendsBody = HTTP_METHOD.parse(config.method).toUpperCase() !== 'GET';
  return [
    ...renderedString('url', config),
    ...headerStrings,
    ...(sendsBody ? renderedString('body', config) : []),
  ];
}

/** The strings actually rendered as Flow templates at runtime, each with the field it belongs to. */
export function getTemplateRenderedStrings(
  blockType: string,
  config: FlowNode['config'],
): readonly RenderedString[] {
  if (!config) return [];
  if (blockType === 'http_request') return httpRequestRenderedStrings(config);
  return getTemplateRenderedFields(blockType, config).flatMap((field) =>
    renderedString(field, config),
  );
}

/** Why a templated value in a field outside {@link getTemplateRenderedFields} stays literal. */
export function nonRenderedFieldNote(blockType: string, field: string): string {
  if (blockType === 'run_command' && field === 'customPath') {
    return 'customPath is intentionally not template-rendered (path traversal prevention)';
  }
  if (blockType === 'http_request' && field === 'headers') {
    return 'headers must be an object of header name to value; a string is ignored, so no headers are sent';
  }
  return `"${field}" is not template-rendered for ${blockType} nodes`;
}
