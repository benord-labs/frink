/** http_request url, header values and a non-GET body are template-rendered at runtime. */
import { describe, expect, it } from 'vitest';
import type { FlowGraph, FlowNode } from './validate-flow-graph';
import { validateFlowTemplateVariables } from './validate-flow-templates';

const makeGraph = (nodes: FlowGraph['nodes']): FlowGraph => ({
  nodes,
  edges: nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: nodes[i]?.id ?? '', target: n.id })),
});

/** An http_request predecessor declares status/body/headers, so any other key is unknown. */
function warningsFor(config: FlowNode['config']) {
  const graph = makeGraph([
    { id: 't', blockType: 'manual_trigger' },
    {
      id: 'up',
      blockType: 'http_request',
      config: { url: 'https://example.com' },
    },
    { id: 'h', blockType: 'http_request', config },
  ]);
  return validateFlowTemplateVariables(graph).filter((w) => w.nodeId === 'h');
}

describe('http_request template validation (sc-3172)', () => {
  it('warns when the url references a key its predecessor does not output', () => {
    const warnings = warningsFor({
      url: 'https://example.com/items/{{previous.idd}}',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      nodeId: 'h',
      field: 'url',
      placeholder: '{{previous.idd}}',
    });
    expect(warnings[0]?.message).not.toContain('not template-rendered');
  });

  it('warns per header value, naming the header', () => {
    const warnings = warningsFor({
      url: 'https://example.com',
      headers: {
        Authorization: 'Bearer {{previous.tokn}}',
        'X-Id': '{{previous.idd}}',
      },
    });
    expect(warnings.map((w) => [w.field, w.placeholder])).toEqual([
      ['headers.Authorization', '{{previous.tokn}}'],
      ['headers.X-Id', '{{previous.idd}}'],
    ]);
  });

  it.each(['post', 'DELETE'])('warns on a body placeholder when the method is %s', (method) => {
    const warnings = warningsFor({
      url: 'https://example.com',
      method,
      body: '{"id":"{{previous.idd}}"}',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      field: 'body',
      placeholder: '{{previous.idd}}',
    });
  });

  it.each([{ method: 'GET' }, { method: 'get' }, {}])(
    'ignores a body the runtime never sends (%o)',
    (methodConfig) => {
      expect(
        warningsFor({
          url: 'https://example.com',
          ...methodConfig,
          body: '{{previous.idd}}',
        }),
      ).toEqual([]);
    },
  );

  it('accepts declared predecessor fields in url, headers and body', () => {
    expect(
      warningsFor({
        url: 'https://example.com/{{previous.status}}',
        method: 'POST',
        headers: { 'X-Status': '{{previous.status}}' },
        body: '{{previous.body}}',
      }),
    ).toEqual([]);
  });

  it('warns that headers given as a string are ignored, so their placeholders never resolve', () => {
    // An agent may stringify the headers object; the runtime then sends no headers at all
    // (dispatch/http-request.ts only reads an object), so silence here would hide a dropped header.
    const warnings = warningsFor({
      url: 'https://example.com',
      headers: '{"Authorization":"Bearer {{previous.tokn}}"}',
    });
    expect(warnings).toMatchObject([{ field: 'headers', placeholder: '{{previous.tokn}}' }]);
    expect(warnings[0]?.message).toContain('must be an object');
  });

  it('warns on a bad placeholder in an array of headers, which the runtime still sends', () => {
    const warnings = warningsFor({ url: 'https://example.com', headers: ['{{previous.idd}}'] });
    expect(warnings).toMatchObject([{ field: 'headers.0', placeholder: '{{previous.idd}}' }]);
  });

  it('accepts a loop placeholder in the url of an http_request inside a fan_out body', () => {
    // Calling an API once per item is the common shape; loop scope must reach http_request.
    const graph: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'fo', blockType: 'fan_out' },
        {
          id: 'h',
          blockType: 'http_request',
          parentId: 'fo',
          config: { url: 'https://example.com/items/{{loop.currentItem.id}}' },
        },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'fo' },
        { id: 'e2', source: 'fo', target: 'h' },
      ],
    };
    expect(validateFlowTemplateVariables(graph).filter((w) => w.nodeId === 'h')).toEqual([]);
  });

  it.each([
    { method: 5, headers: null, body: '{{previous.idd}}' },
    { headers: { 'X-Count': 3, 'X-Nested': { a: '{{previous.idd}}' } } },
  ])('does not throw or warn on malformed config %o', (extra) => {
    expect(warningsFor({ url: 'https://example.com', ...extra })).toEqual([]);
  });
});
