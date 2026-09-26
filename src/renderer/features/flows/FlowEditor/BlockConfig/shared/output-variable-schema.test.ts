import { describe, expect, it } from 'vitest';
import {
  CUSTOM_NODE_FALLBACK_OUTPUT_SCHEMA,
  OUTPUT_SCHEMAS,
  type OutputFieldSchema,
} from '../../../../../../shared/lib/output-schemas';
import { type CustomNodeSchema, getOutputSchemaForBlockType } from './output-variable-schema';

/**
 * Branch coverage for the predecessor-block → `{{previous.*}}` output schema
 * resolver shown in the Available Variables panel. Behaviour is purely a function
 * of block type + the resolved custom-node schemas the panel supplies, so it is
 * exercised here without rendering the React panel.
 */

const keys = (fields: OutputFieldSchema[]) => fields.map((f) => f.key);

const customSchema = (overrides: Partial<CustomNodeSchema> = {}): CustomNodeSchema => ({
  topLevelFields: [{ key: 'items', type: 'array', description: 'rows', guaranteed: true }],
  ...overrides,
});

describe('getOutputSchemaForBlockType — custom (non-built-in) nodes', () => {
  it('uses the manifest top-level fields when a custom schema is supplied', () => {
    const schema = customSchema({
      topLevelFields: [{ key: 'sha', type: 'string', description: 'commit', guaranteed: true }],
    });
    const result = getOutputSchemaForBlockType('my_custom_node', { customNodeSchema: schema });

    expect(result.fields).toBe(schema.topLevelFields);
    expect(result.note).toContain("node's manifest");
  });

  it('falls back to the run_command schema + declare-outputs hint when no custom schema', () => {
    const result = getOutputSchemaForBlockType('my_custom_node', { customNodeSchema: null });

    expect(result.fields).toBe(CUSTOM_NODE_FALLBACK_OUTPUT_SCHEMA);
    expect(result.note).toContain('manifest.json');
  });
});

describe('getOutputSchemaForBlockType — built-in defaults', () => {
  it('returns the static schema with no note for a plain block (agent)', () => {
    const result = getOutputSchemaForBlockType('agent');

    expect(result.fields).toBe(OUTPUT_SCHEMAS.agent);
    expect(result.note).toBeUndefined();
    expect(result.currentItemFields).toBeUndefined();
  });

  it('annotates http_request headers as dot-notation accessible', () => {
    const result = getOutputSchemaForBlockType('http_request');

    expect(result.fields).toBe(OUTPUT_SCHEMAS.http_request);
    expect(result.note).toContain('dot notation');
  });
});

describe('getOutputSchemaForBlockType — run_command', () => {
  it('resolves declared expectedOutputs (exitCode prepended) with a declared-fields note', () => {
    const result = getOutputSchemaForBlockType('run_command', {
      expectedOutputs: { message: { type: 'string' } },
    });

    expect(keys(result.fields)).toEqual(['exitCode', 'message']);
    expect(result.note).toContain('Declared output fields');
  });

  it('treats an empty expectedOutputs object as undeclared (guaranteed-fields branch)', () => {
    const result = getOutputSchemaForBlockType('run_command', { expectedOutputs: {} });

    expect(result.fields).toBe(OUTPUT_SCHEMAS.run_command);
    expect(result.note).toContain('Guaranteed fields only');
  });

  it('uses guaranteed fields when expectedOutputs is null', () => {
    const result = getOutputSchemaForBlockType('run_command', { expectedOutputs: null });

    expect(result.fields).toBe(OUTPUT_SCHEMAS.run_command);
    expect(result.note).toContain('Guaranteed fields only');
  });
});

describe('getOutputSchemaForBlockType — fan_out', () => {
  it('marks currentItem primitive when the source custom node iterates primitives', () => {
    const result = getOutputSchemaForBlockType('fan_out', {
      fanOutSourceCustomNodeSchema: customSchema({ currentItemIsPrimitive: true }),
    });

    expect(result.currentItemIsPrimitive).toBe(true);
    expect(result.currentItemFields).toEqual([]);
    expect(result.note).toContain('primitives');
  });

  it('exposes the source custom node currentItem sub-fields when present', () => {
    const subFields: OutputFieldSchema[] = [
      { key: 'title', type: 'string', description: 'title', guaranteed: true },
    ];
    const result = getOutputSchemaForBlockType('fan_out', {
      fanOutSourceCustomNodeSchema: customSchema({ currentItemSubFields: subFields }),
    });

    expect(result.currentItemFields).toBe(subFields);
    expect(result.note).toBeUndefined();
  });

  it('falls back to top-level fields when currentItemSubFields is an empty array', () => {
    const schema = customSchema({ currentItemSubFields: [] });
    const result = getOutputSchemaForBlockType('fan_out', {
      fanOutSourceCustomNodeSchema: schema,
    });

    expect(result.currentItemFields).toBe(schema.topLevelFields);
    expect(result.note).toContain("node's top-level outputs");
  });

  it('uses the source built-in schema for a static (non run_command) source', () => {
    const result = getOutputSchemaForBlockType('fan_out', { fanOutSourceBlockType: 'agent' });

    expect(result.currentItemFields).toBe(OUTPUT_SCHEMAS.agent);
    expect(result.note).toBeUndefined();
  });

  it('treats a run_command source as dynamic', () => {
    const result = getOutputSchemaForBlockType('fan_out', {
      fanOutSourceBlockType: 'run_command',
    });

    expect(result.currentItemFields).toEqual([]);
    expect(result.note).toContain('dynamic JSON');
  });

  it('treats an unknown (custom) source string as dynamic', () => {
    const result = getOutputSchemaForBlockType('fan_out', {
      fanOutSourceBlockType: 'my_custom_node',
    });

    expect(result.currentItemFields).toEqual([]);
    expect(result.note).toContain('dynamic JSON');
  });

  it('treats a missing source as dynamic', () => {
    const result = getOutputSchemaForBlockType('fan_out', {});

    expect(result.currentItemFields).toEqual([]);
    expect(result.note).toContain('dynamic JSON');
  });
});

describe('getOutputSchemaForBlockType — condition passthrough', () => {
  it('returns only the condition result field when there is no grandparent', () => {
    const result = getOutputSchemaForBlockType('condition', {});

    expect(keys(result.fields)).toEqual(['result']);
    expect(result.note).toBeUndefined();
  });

  it('passes through a built-in grandparent schema plus result', () => {
    const result = getOutputSchemaForBlockType('condition', {
      fanOutSourceBlockType: 'agent',
    });

    expect(keys(result.fields)).toEqual([...keys(OUTPUT_SCHEMAS.agent), 'result']);
    expect(result.note).toBeUndefined();
  });

  it('uses grandparent manifest fields (no dynamic note) when a custom schema is supplied', () => {
    const schema = customSchema({
      topLevelFields: [{ key: 'count', type: 'number', description: 'n', guaranteed: true }],
    });
    const result = getOutputSchemaForBlockType('condition', {
      fanOutSourceBlockType: 'my_custom_node',
      fanOutSourceCustomNodeSchema: schema,
    });

    expect(keys(result.fields)).toEqual(['count', 'result']);
    expect(result.note).toBeUndefined();
  });

  it('falls back + flags dynamic when the custom grandparent has no schema', () => {
    const result = getOutputSchemaForBlockType('condition', {
      fanOutSourceBlockType: 'my_custom_node',
      fanOutSourceCustomNodeSchema: null,
    });

    expect(keys(result.fields)).toEqual([...keys(CUSTOM_NODE_FALLBACK_OUTPUT_SCHEMA), 'result']);
    expect(result.note).toContain('Dynamic fields');
  });

  it('resolves a run_command grandparent expectedOutputs without a dynamic note', () => {
    const result = getOutputSchemaForBlockType('condition', {
      fanOutSourceBlockType: 'run_command',
      fanOutSourceExpectedOutputs: { status: { type: 'string' } },
    });

    expect(keys(result.fields)).toEqual(['exitCode', 'status', 'result']);
    expect(result.note).toBeUndefined();
  });

  it('flags dynamic for a run_command grandparent with no expectedOutputs', () => {
    const result = getOutputSchemaForBlockType('condition', {
      fanOutSourceBlockType: 'run_command',
    });

    expect(keys(result.fields)).toEqual([...keys(OUTPUT_SCHEMAS.run_command), 'result']);
    expect(result.note).toContain('Dynamic fields');
  });

  it("dedupes a grandparent 'result' field so the condition's own result wins", () => {
    // A grandparent whose passthrough already contains `result` (e.g. another condition)
    // must not double-list it — condition output is { ...upstream, result }.
    const result = getOutputSchemaForBlockType('condition', {
      fanOutSourceBlockType: 'condition',
    });

    expect(result.fields.filter((f) => f.key === 'result')).toHaveLength(1);
  });
});
