import { describe, expect, it } from 'vitest';
import { flowSettingsShapeSchema } from './flow-settings-schema.js';

describe('flowSettingsShapeSchema — autoReviewTools', () => {
  it('accepts explicit enablement and disablement, and leaves legacy graphs valid', () => {
    expect(flowSettingsShapeSchema.safeParse({}).success).toBe(true);
    expect(flowSettingsShapeSchema.safeParse({ autoReviewTools: true }).success).toBe(true);
    expect(flowSettingsShapeSchema.safeParse({ autoReviewTools: false }).success).toBe(true);
  });

  it('rejects non-boolean Auto Mode settings', () => {
    expect(flowSettingsShapeSchema.safeParse({ autoReviewTools: 'on' }).success).toBe(false);
  });
});

describe('flowSettingsShapeSchema — codexFastMode', () => {
  it('round-trips through the schema so frink_flows_patch cannot silently drop it', () => {
    // `flow-patch.ts` validates settings with `flowSettingsShapeSchema.partial()`, and zod strips
    // unknown keys — an unmirrored field would be accepted and then vanish.
    expect(flowSettingsShapeSchema.safeParse({}).success).toBe(true);
    for (const codexFastMode of [true, false]) {
      const parsed = flowSettingsShapeSchema.safeParse({ codexFastMode });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.codexFastMode).toBe(codexFastMode);
    }
  });

  it('rejects non-boolean Fast settings', () => {
    expect(flowSettingsShapeSchema.safeParse({ codexFastMode: 'on' }).success).toBe(false);
  });
});

describe('flowSettingsShapeSchema — batchTriggerSchema (sc-654)', () => {
  it('accepts a valid array of schema items', () => {
    const result = flowSettingsShapeSchema.safeParse({
      batchTriggerSchema: [
        { key: 'ticketId', type: 'string', description: 'Ticket ID' },
        { key: 'workstreamId', type: 'number' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('is optional — omitting batchTriggerSchema is valid (EC13)', () => {
    expect(flowSettingsShapeSchema.safeParse({}).success).toBe(true);
    expect(flowSettingsShapeSchema.safeParse({ maxBatchConcurrency: 5 }).success).toBe(true);
  });

  it('accepts an empty array (EC3)', () => {
    const result = flowSettingsShapeSchema.safeParse({ batchTriggerSchema: [] });
    expect(result.success).toBe(true);
  });

  it('rejects invalid key pattern — starts with digit (EC4)', () => {
    const result = flowSettingsShapeSchema.safeParse({
      batchTriggerSchema: [{ key: '1invalid', type: 'string' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid key pattern — contains hyphen (EC4)', () => {
    const result = flowSettingsShapeSchema.safeParse({
      batchTriggerSchema: [{ key: 'my-field', type: 'string' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts underscore-prefixed key (valid identifier) (EC4)', () => {
    const result = flowSettingsShapeSchema.safeParse({
      batchTriggerSchema: [{ key: '_private', type: 'string' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects key exceeding 64 characters (EC8)', () => {
    const longKey = 'a'.repeat(65);
    const result = flowSettingsShapeSchema.safeParse({
      batchTriggerSchema: [{ key: longKey, type: 'string' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts key of exactly 64 characters (EC8 boundary)', () => {
    const key64 = 'a'.repeat(64);
    const result = flowSettingsShapeSchema.safeParse({
      batchTriggerSchema: [{ key: key64, type: 'string' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects more than 100 entries (EC7)', () => {
    const items = Array.from({ length: 101 }, (_, i) => ({
      key: `field${i}`,
      type: 'string' as const,
    }));
    const result = flowSettingsShapeSchema.safeParse({ batchTriggerSchema: items });
    expect(result.success).toBe(false);
  });

  it('accepts exactly 100 entries (EC7 boundary)', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      key: `field${i}`,
      type: 'string' as const,
    }));
    const result = flowSettingsShapeSchema.safeParse({ batchTriggerSchema: items });
    expect(result.success).toBe(true);
  });

  it('rejects unknown type values', () => {
    const result = flowSettingsShapeSchema.safeParse({
      batchTriggerSchema: [{ key: 'myField', type: 'date' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts all valid type values', () => {
    for (const type of ['string', 'number', 'boolean', 'object', 'array']) {
      const result = flowSettingsShapeSchema.safeParse({
        batchTriggerSchema: [{ key: 'myField', type }],
      });
      expect(result.success).toBe(true);
    }
  });

  it('description and example are optional', () => {
    const result = flowSettingsShapeSchema.safeParse({
      batchTriggerSchema: [{ key: 'myField', type: 'string' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects description exceeding 200 characters', () => {
    const result = flowSettingsShapeSchema.safeParse({
      batchTriggerSchema: [{ key: 'myField', type: 'string', description: 'x'.repeat(201) }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects example exceeding 200 characters', () => {
    const result = flowSettingsShapeSchema.safeParse({
      batchTriggerSchema: [{ key: 'myField', type: 'string', example: 'x'.repeat(201) }],
    });
    expect(result.success).toBe(false);
  });
});

describe('flowSettingsShapeSchema — maxBatchConcurrency', () => {
  it('accepts valid values: 1 and 20 (inclusive boundaries)', () => {
    expect(flowSettingsShapeSchema.safeParse({ maxBatchConcurrency: 1 }).success).toBe(true);
    expect(flowSettingsShapeSchema.safeParse({ maxBatchConcurrency: 20 }).success).toBe(true);
  });

  it('accepts mid-range value', () => {
    expect(flowSettingsShapeSchema.safeParse({ maxBatchConcurrency: 5 }).success).toBe(true);
  });

  it('rejects 0 (below minimum)', () => {
    const result = flowSettingsShapeSchema.safeParse({ maxBatchConcurrency: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects 21 (above maximum)', () => {
    const result = flowSettingsShapeSchema.safeParse({ maxBatchConcurrency: 21 });
    expect(result.success).toBe(false);
  });

  it('rejects fractional values (1.5)', () => {
    const result = flowSettingsShapeSchema.safeParse({ maxBatchConcurrency: 1.5 });
    expect(result.success).toBe(false);
  });

  it('rejects negative values', () => {
    const result = flowSettingsShapeSchema.safeParse({ maxBatchConcurrency: -1 });
    expect(result.success).toBe(false);
  });

  it('is optional — omitting maxBatchConcurrency is valid', () => {
    expect(flowSettingsShapeSchema.safeParse({}).success).toBe(true);
    expect(flowSettingsShapeSchema.safeParse({ pauseOnFailure: true }).success).toBe(true);
  });
});
