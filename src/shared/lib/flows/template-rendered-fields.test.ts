import { describe, expect, it } from 'vitest';
import {
  getTemplateRenderedFields,
  getTemplateRenderedStrings,
  nonRenderedFieldNote,
} from './template-rendered-fields';
import type { FlowNode } from '../validate-flow-graph';

describe('getTemplateRenderedFields', () => {
  it('lists projectId so a run can be routed to a project resolved at run time', () => {
    expect(getTemplateRenderedFields('start_task', {})).toContain('projectId');
    expect(getTemplateRenderedFields('run_command', {})).toContain('projectId');
    // agent takes its project from the upstream start_task's outputs, and custom-node dispatch
    // reads projectId statically — a template in either would be inert.
    expect(getTemplateRenderedFields('agent', {})).not.toContain('projectId');
    expect(
      getTemplateRenderedFields('check-new-prs', { projectId: '{{trigger.project}}' }),
    ).not.toContain('projectId');
  });

  it('selects only the active chat_reply variant fields', () => {
    expect(getTemplateRenderedFields('chat_reply', { messageTemplate: 'Hello' })).toEqual([
      'messageTemplate',
    ]);
    expect(
      getTemplateRenderedFields('chat_reply', {
        contentType: 'html_artifact',
        artifactTitleTemplate: 'Report',
        artifactBodyHtmlTemplate: '<p>Done</p>',
        messageTemplate: 'stale hidden field',
      }),
    ).toEqual(['artifactTitleTemplate', 'artifactBodyHtmlTemplate']);
  });
});

describe('getTemplateRenderedStrings', () => {
  it('yields the string values of the rendered fields', () => {
    expect(
      getTemplateRenderedStrings('run_command', { command: 'echo hi', projectId: 7, cwd: 'x' }),
    ).toEqual([{ field: 'command', value: 'echo hi' }]);
    expect(getTemplateRenderedStrings('run_command', undefined)).toEqual([]);
  });

  it('yields http_request url, each string header value, and a non-GET body', () => {
    expect(
      getTemplateRenderedStrings('http_request', {
        url: 'https://example.com',
        method: 'post',
        headers: { Authorization: 'Bearer x', 'X-Count': 3 },
        body: '{}',
      }),
    ).toEqual([
      { field: 'url', value: 'https://example.com' },
      { field: 'headers.Authorization', value: 'Bearer x' },
      { field: 'body', value: '{}' },
    ]);
  });

  it('skips an http_request body under GET, the default method, and malformed config', () => {
    const url = { field: 'url', value: 'https://example.com' };
    const rendered = (extra: FlowNode['config']) =>
      getTemplateRenderedStrings('http_request', { url: url.value, ...extra });
    expect(rendered({ method: 'GET', body: '{}' })).toEqual([url]);
    expect(rendered({ body: '{}' })).toEqual([url]);
    expect(rendered({ method: 5, headers: null, body: '{}' })).toEqual([url]);
  });
});

describe('getTemplateRenderedStrings — header arrays', () => {
  it('renders an array of headers by index, as the runtime iterates any object', () => {
    // dispatch/http-request.ts sends each entry of an array as a header named by its index.
    expect(
      getTemplateRenderedStrings('http_request', { url: 'https://example.com', headers: ['a', 3] }),
    ).toEqual([
      { field: 'url', value: 'https://example.com' },
      { field: 'headers.0', value: 'a' },
    ]);
  });
});

describe('nonRenderedFieldNote', () => {
  it('explains the special cases and names the field otherwise', () => {
    expect(nonRenderedFieldNote('run_command', 'customPath')).toContain('path traversal');
    expect(nonRenderedFieldNote('http_request', 'headers')).toContain('must be an object');
    expect(nonRenderedFieldNote('http_request', 'method')).toBe(
      '"method" is not template-rendered for http_request nodes',
    );
  });
});
