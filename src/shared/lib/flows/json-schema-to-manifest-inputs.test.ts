import { describe, expect, it } from 'vitest';
import { jsonSchemaToManifestInputs } from './json-schema-to-manifest-inputs';

describe('jsonSchemaToManifestInputs', () => {
  it('projects each scalar type onto the manifest input type', () => {
    const { inputs, unsupportedFields } = jsonSchemaToManifestInputs({
      type: 'object',
      properties: {
        channel: { type: 'string' },
        limit: { type: 'number' },
        offset: { type: 'integer' },
        markdown: { type: 'boolean' },
      },
    });

    expect(inputs).toEqual({
      channel: { type: 'string' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      markdown: { type: 'boolean' },
    });
    expect(unsupportedFields).toEqual([]);
  });

  it('marks only properties listed in required', () => {
    const { inputs } = jsonSchemaToManifestInputs({
      type: 'object',
      properties: {
        channel: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['channel'],
    });

    expect(inputs.channel?.required).toBe(true);
    expect(inputs.text?.required).toBeUndefined();
  });

  it('carries defaults through, including falsy ones', () => {
    const { inputs } = jsonSchemaToManifestInputs({
      type: 'object',
      properties: {
        limit: { type: 'number', default: 0 },
        markdown: { type: 'boolean', default: false },
        text: { type: 'string', default: 'hello' },
      },
    });

    expect(inputs.limit?.default).toBe(0);
    expect(inputs.markdown?.default).toBe(false);
    expect(inputs.text?.default).toBe('hello');
  });

  it('maps title to label and keeps the description whole, for help text under the field', () => {
    const { inputs } = jsonSchemaToManifestInputs({
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          title: 'Channel',
          description:
            'The channel to post in. Use the channel name, not its id, and include the leading hash.',
        },
        bare: { type: 'string', title: '  ', description: '' },
      },
    });

    // A long description must survive projection intact — the field renders it as help text.
    expect(inputs.channel).toEqual({
      type: 'string',
      label: 'Channel',
      description:
        'The channel to post in. Use the channel name, not its id, and include the leading hash.',
    });
    expect(inputs.bare).toEqual({ type: 'string' });
  });

  it('projects same-typed scalar enums as options that keep their JSON type', () => {
    const { inputs, unsupportedFields } = jsonSchemaToManifestInputs({
      type: 'object',
      properties: {
        visibility: { type: 'string', enum: ['public', 'private'] },
        priority: { enum: [1, 2, 3] },
      },
    });

    expect(inputs.visibility).toEqual({ type: 'string', options: ['public', 'private'] });
    expect(inputs.priority).toEqual({ type: 'number', options: [1, 2, 3] });
    // An empty string is a legal enum member; the select renders it, dispatch sends it verbatim.
    expect(
      jsonSchemaToManifestInputs({ properties: { mode: { enum: ['', 'auto'] } } }).inputs.mode,
    ).toEqual({
      type: 'string',
      options: ['', 'auto'],
    });
    expect(unsupportedFields).toEqual([]);
  });

  it('reports empty, mixed or non-scalar enums as unsupported', () => {
    const { inputs, unsupportedFields } = jsonSchemaToManifestInputs({
      type: 'object',
      properties: {
        empty: { enum: [] },
        objects: { enum: [{ id: 1 }] },
        mixed: { enum: ['a', 1] },
      },
    });

    expect(inputs).toEqual({});
    expect(unsupportedFields).toEqual(['empty', 'objects', 'mixed']);
  });

  it('projects nested and composed properties as raw json fields, defaults intact', () => {
    const { inputs, unsupportedFields } = jsonSchemaToManifestInputs({
      type: 'object',
      properties: {
        channel: { type: 'string' },
        blocks: { type: 'array', items: { type: 'object' } },
        metadata: { type: 'object', properties: {}, default: { team: 'core' } },
        preset: { type: 'array', enum: [['a'], ['b']] },
        target: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        source: { anyOf: [{ type: 'string' }] },
        merged: { allOf: [{ type: 'string' }] },
      },
      required: ['blocks'],
    });

    expect(inputs).toEqual({
      channel: { type: 'string' },
      blocks: { type: 'json', required: true },
      metadata: { type: 'json', default: { team: 'core' } },
      preset: { type: 'json' },
      target: { type: 'json' },
      source: { type: 'json' },
      merged: { type: 'json' },
    });
    expect(unsupportedFields).toEqual([]);
  });

  it('reports unknown, union, and malformed property types as unsupported', () => {
    const { inputs, unsupportedFields } = jsonSchemaToManifestInputs({
      type: 'object',
      properties: {
        mystery: { type: 'timestamp' },
        nullable: { type: ['string', 'null'] },
        untyped: {},
        broken: true,
        malformedComposition: { oneOf: 'malformed' },
        emptyComposition: { anyOf: [] },
      },
    });

    expect(inputs).toEqual({});
    expect(unsupportedFields).toEqual([
      'mystery',
      'nullable',
      'untyped',
      'broken',
      'malformedComposition',
      'emptyComposition',
    ]);
  });

  it('returns empty maps for an empty or property-less schema', () => {
    expect(jsonSchemaToManifestInputs({ type: 'object', properties: {} })).toEqual({
      inputs: {},
      unsupportedFields: [],
    });
    expect(jsonSchemaToManifestInputs({})).toEqual({ inputs: {}, unsupportedFields: [] });
  });

  it('ignores non-string entries in the required list', () => {
    const { inputs } = jsonSchemaToManifestInputs({
      type: 'object',
      properties: { channel: { type: 'string' } },
      required: [42, 'channel'],
    });

    expect(inputs.channel?.required).toBe(true);
  });
});
