import { describe, expect, it } from 'vitest';
import { jsonSchemaToManifestInputs } from './json-schema-to-manifest-inputs';
import {
  type JsonNode,
  mcpToolPresetSchema,
  selectMcpPresetSchema,
  wrapMcpPresetArgs,
} from './mcp-tool-preset';

const preset = mcpToolPresetSchema.parse({
  inputPath: ['actions', 0, 'list_pages'],
  fixedArgs: {
    actions: [{ label: 'list_pages', list_pages: {} }],
    context: 'Fixed catalog context',
  },
});
// Hosted Webflow tools/list: the selected operation and its referenced scalar definitions.
const branch = {
  type: 'object',
  properties: {
    label: { $ref: '#/$defs/label' },
    list_pages: {
      type: 'object',
      properties: {
        site_id: { $ref: '#/$defs/site_id' },
        localeId: { $ref: '#/$defs/localeId2' },
        limit: { type: 'number' },
        offset: { type: 'number' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  required: ['label', 'list_pages'],
  additionalProperties: false,
};
const hosted = {
  type: 'object',
  properties: {
    actions: { type: 'array', items: { anyOf: [branch] } },
    context: { type: 'string' },
  },
  required: ['actions', 'context'],
  $defs: {
    label: { type: 'string' },
    site_id: { type: 'string', description: "The site's unique ID." },
    localeId2: {
      type: 'string',
      description: 'Unique identifier for a specific locale.',
    },
  },
};

describe('MCP operation presets', () => {
  const bundled = {
    inputPath: ['request'],
    fixedArgs: { service: 'payments', method: 'get', request: {} },
    inputSchema: {
      type: 'object' as const,
      properties: { payment_id: { type: 'string' } },
      required: ['payment_id'],
    },
  };

  it.each([true, {}])(
    'uses bundled fields with an open vendor request schema (%j)',
    (additionalProperties) => {
      const selected = selectMcpPresetSchema(
        {
          type: 'object',
          properties: {
            request: {
              type: 'object',
              properties: {},
              additionalProperties,
            },
          },
        },
        bundled,
      );
      expect(selected).toEqual({ ok: true, schema: bundled.inputSchema });
      if (!selected.ok) throw new Error(selected.reason);
      expect(jsonSchemaToManifestInputs(selected.schema).inputs).toEqual({
        payment_id: { type: 'string', required: true },
      });
      expect(wrapMcpPresetArgs(bundled, { payment_id: 'payment-1' })).toEqual({
        service: 'payments',
        method: 'get',
        request: { payment_id: 'payment-1' },
      });
    },
  );

  it.each([
    { type: 'object', properties: {}, additionalProperties: false },
    {
      type: 'object',
      properties: { new_field: { type: 'string' } },
      additionalProperties: true,
    },
    { type: 'string' },
  ])('does not let bundled fields conceal a changed vendor contract (%#)', (request) => {
    // SAFETY: each case is a literal JSON schema shape the parser must reject.
    expect(
      selectMcpPresetSchema({ type: 'object', properties: { request } } as JsonNode, bundled).ok,
    ).toBe(false);
  });

  it('projects the hosted operation fields and local scalar references without exposing wrapper fields', () => {
    const selected = selectMcpPresetSchema(hosted, preset);
    expect(selected.ok).toBe(true);
    if (!selected.ok) throw new Error(selected.reason);
    expect(jsonSchemaToManifestInputs(selected.schema)).toEqual({
      inputs: {
        site_id: {
          type: 'string',
          required: true,
          description: "The site's unique ID.",
        },
        localeId: {
          type: 'string',
          description: 'Unique identifier for a specific locale.',
        },
        limit: { type: 'number' },
        offset: { type: 'number' },
      },
      unsupportedFields: [],
    });
  });

  it.each([
    { anyOf: [] },
    { anyOf: [branch, branch] },
    {
      anyOf: [{ type: 'object', properties: { list_pages: { type: 'string' } } }],
    },
  ])('refuses missing, ambiguous, or non-object operation schemas (%#)', ({ anyOf }) => {
    expect(
      selectMcpPresetSchema(
        {
          ...hosted,
          properties: { actions: { type: 'array', items: { anyOf } } },
        },
        preset,
      ).ok,
    ).toBe(false);
  });

  it('refuses unresolved or cyclic local references', () => {
    expect(selectMcpPresetSchema({ ...hosted, $defs: {} }, preset).ok).toBe(false);
    expect(
      selectMcpPresetSchema(
        {
          ...hosted,
          $defs: { ...hosted.$defs, site_id: { $ref: '#/$defs/site_id' } },
        },
        preset,
      ).ok,
    ).toBe(false);
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects prototype traversal through %s',
    (key) => {
      expect(
        mcpToolPresetSchema.safeParse({
          inputPath: [key],
          fixedArgs: JSON.parse(`{"${key}":{}}`),
        }).success,
      ).toBe(false);
    },
  );

  it('requires a pre-existing empty input slot instead of overwriting fixed defaults', () => {
    expect(mcpToolPresetSchema.safeParse({ ...preset, inputPath: ['missing'] }).success).toBe(
      false,
    );
    expect(
      mcpToolPresetSchema.safeParse({
        ...preset,
        fixedArgs: { actions: [{ list_pages: { site_id: 'fixed' } }] },
      }).success,
    ).toBe(false);
  });

  it('clones each call and atomically inserts structured arguments without merging wrapper overrides', async () => {
    const input = {
      site_id: 'site-a',
      request: { filters: ['x'] },
      context: 'user-context',
      actions: [],
    };
    const [first, second] = await Promise.all([
      Promise.resolve(wrapMcpPresetArgs(preset, input)),
      Promise.resolve(wrapMcpPresetArgs(preset, { site_id: 'site-b' })),
    ]);
    input.request.filters.push('changed');
    expect(first).toEqual({
      actions: [
        {
          label: 'list_pages',
          list_pages: {
            site_id: 'site-a',
            request: { filters: ['x'] },
            context: 'user-context',
            actions: [],
          },
        },
      ],
      context: 'Fixed catalog context',
    });
    expect(second).toEqual({
      actions: [{ label: 'list_pages', list_pages: { site_id: 'site-b' } }],
      context: 'Fixed catalog context',
    });
    expect(preset.fixedArgs).toEqual({
      actions: [{ label: 'list_pages', list_pages: {} }],
      context: 'Fixed catalog context',
    });
  });
});
