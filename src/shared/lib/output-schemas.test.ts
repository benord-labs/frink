import { describe, expect, it } from 'vitest';
import { V1_FLOW_BLOCK_DEFINITIONS } from './block-registry';
import {
  CUSTOM_NODE_FALLBACK_OUTPUT_SCHEMA,
  manifestOutputsToSchema,
  OUTPUT_SCHEMAS,
  type OutputFieldSchema,
  TRIGGER_SCHEMAS,
} from './output-schemas';

describe('OUTPUT_SCHEMAS', () => {
  const ACTION_BLOCK_TYPES = V1_FLOW_BLOCK_DEFINITIONS.filter((d) => !d.isTrigger).map(
    (d) => d.type,
  );
  // approval has no outputs (flow pauses), so it is not expected to have an entry
  const EXPECTED_BLOCK_TYPES = ACTION_BLOCK_TYPES.filter((t) => t !== 'approval');

  it('has an entry for every non-trigger, non-approval block type', () => {
    for (const blockType of EXPECTED_BLOCK_TYPES) {
      expect(OUTPUT_SCHEMAS, `missing schema for "${blockType}"`).toHaveProperty(blockType);
    }
  });

  it('every field has a non-empty key and description', () => {
    for (const [blockType, fields] of Object.entries(OUTPUT_SCHEMAS)) {
      for (const field of fields as OutputFieldSchema[]) {
        expect(field.key, `${blockType}: field key must be non-empty`).toBeTruthy();
        expect(
          field.description,
          `${blockType}.${field.key}: description must be non-empty`,
        ).toBeTruthy();
      }
    }
  });

  it('every field has a valid type', () => {
    const VALID_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array', 'unknown']);
    for (const [blockType, fields] of Object.entries(OUTPUT_SCHEMAS)) {
      for (const field of fields as OutputFieldSchema[]) {
        expect(
          VALID_TYPES.has(field.type),
          `${blockType}.${field.key}: invalid type "${field.type}"`,
        ).toBe(true);
      }
    }
  });

  it('every field has a boolean guaranteed flag', () => {
    for (const [blockType, fields] of Object.entries(OUTPUT_SCHEMAS)) {
      for (const field of fields as OutputFieldSchema[]) {
        expect(
          typeof field.guaranteed,
          `${blockType}.${field.key}: guaranteed must be boolean`,
        ).toBe('boolean');
      }
    }
  });

  it('run_command has exitCode as a guaranteed field', () => {
    const fields = OUTPUT_SCHEMAS.run_command ?? [];
    const exitCode = fields.find((f) => f.key === 'exitCode');
    expect(exitCode).toBeDefined();
    expect(exitCode?.guaranteed).toBe(true);
    expect(exitCode?.type).toBe('number');
  });

  it('agent has chatId as a guaranteed field', () => {
    const fields = OUTPUT_SCHEMAS.agent ?? [];
    const chatId = fields.find((f) => f.key === 'chatId');
    expect(chatId).toBeDefined();
    expect(chatId?.guaranteed).toBe(true);
  });

  it('fan_out has currentItem and currentIndex as guaranteed fields', () => {
    const fields = OUTPUT_SCHEMAS.fan_out ?? [];
    const currentItem = fields.find((f) => f.key === 'currentItem');
    const currentIndex = fields.find((f) => f.key === 'currentIndex');
    expect(currentItem).toBeDefined();
    expect(currentItem?.guaranteed).toBe(true);
    expect(currentIndex).toBeDefined();
    expect(currentIndex?.guaranteed).toBe(true);
  });

  it('condition has result as a guaranteed field', () => {
    const fields = OUTPUT_SCHEMAS.condition ?? [];
    const result = fields.find((f) => f.key === 'result');
    expect(result).toBeDefined();
    expect(result?.guaranteed).toBe(true);
  });

  it('http_request has status, body, headers, truncated as guaranteed fields', () => {
    const fields = OUTPUT_SCHEMAS.http_request ?? [];
    for (const key of ['status', 'body', 'headers', 'truncated']) {
      const f = fields.find((f) => f.key === key);
      expect(f, `http_request missing "${key}"`).toBeDefined();
      expect(f?.guaranteed, `http_request.${key} should be guaranteed`).toBe(true);
    }
  });

  it('chat_reply matches the reachable local dispatcher output contract', () => {
    expect(OUTPUT_SCHEMAS.chat_reply).toEqual([
      expect.objectContaining({ key: 'chatId', guaranteed: true }),
      expect.objectContaining({ key: 'subChatId', guaranteed: true }),
      expect.objectContaining({ key: 'delivered', guaranteed: true }),
      expect.objectContaining({ key: 'message', guaranteed: true }),
      expect.objectContaining({ key: 'contentType', guaranteed: true }),
      expect.objectContaining({ key: 'artifactId', guaranteed: false }),
      expect.objectContaining({ key: 'title', guaranteed: false }),
    ]);
  });
});

describe('TRIGGER_SCHEMAS', () => {
  const TRIGGER_BLOCK_TYPES = V1_FLOW_BLOCK_DEFINITIONS.filter((d) => d.isTrigger).map(
    (d) => d.type,
  );

  it('has an entry for every trigger block type', () => {
    for (const triggerType of TRIGGER_BLOCK_TYPES) {
      expect(TRIGGER_SCHEMAS, `missing trigger schema for "${triggerType}"`).toHaveProperty(
        triggerType,
      );
    }
  });

  it('every trigger field has a non-empty key and description', () => {
    for (const [triggerType, fields] of Object.entries(TRIGGER_SCHEMAS)) {
      for (const field of fields) {
        expect(field.key, `${triggerType}: field key must be non-empty`).toBeTruthy();
        expect(
          field.description,
          `${triggerType}.${field.key}: description must be non-empty`,
        ).toBeTruthy();
      }
    }
  });

  it('post_task_trigger has taskId, source, projectId, branch, baseBranch, worktreePath, chatId', () => {
    const fields = TRIGGER_SCHEMAS.post_task_trigger ?? [];
    for (const key of [
      'taskId',
      'source',
      'projectId',
      'branch',
      'baseBranch',
      'worktreePath',
      'chatId',
    ]) {
      expect(
        fields.find((f) => f.key === key),
        `post_task_trigger missing "${key}"`,
      ).toBeDefined();
    }
  });
});

describe('manifestOutputsToSchema', () => {
  it('returns an empty array for undefined outputs', () => {
    expect(manifestOutputsToSchema(undefined)).toEqual([]);
  });

  it('returns an empty array for a declared-but-empty outputs object', () => {
    expect(manifestOutputsToSchema({})).toEqual([]);
  });

  it('maps a declared field, defaulting a missing description to the key', () => {
    const schema = manifestOutputsToSchema({
      prCount: { type: 'number', description: 'Number of open PRs' },
      rawTitle: { type: 'string' },
    });
    expect(schema).toEqual([
      { key: 'prCount', type: 'number', description: 'Number of open PRs', guaranteed: true },
      { key: 'rawTitle', type: 'string', description: 'rawTitle', guaranteed: true },
    ]);
  });

  it('marks every declared field guaranteed regardless of manifest content', () => {
    const schema = manifestOutputsToSchema({ a: { type: 'boolean' }, b: { type: 'array' } });
    expect(schema.every((f) => f.guaranteed)).toBe(true);
  });
});

describe('CUSTOM_NODE_FALLBACK_OUTPUT_SCHEMA', () => {
  it('is the same reference as run_command schema', () => {
    expect(CUSTOM_NODE_FALLBACK_OUTPUT_SCHEMA).toBe(OUTPUT_SCHEMAS.run_command);
  });

  it('has exitCode field', () => {
    const exitCode = CUSTOM_NODE_FALLBACK_OUTPUT_SCHEMA.find((f) => f.key === 'exitCode');
    expect(exitCode).toBeDefined();
  });
});
