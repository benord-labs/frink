import { initTRPC } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { transformResultDataToCamelCase } from './case-convert-middleware';

const buildTestRouter = () => {
  const t = initTRPC.create();
  const caseConvertOutput = t.middleware(async ({ next }) => {
    const result = await next();
    if (!result.ok) return result;
    return {
      ...result,
      data: transformResultDataToCamelCase(result.data),
    } as typeof result;
  });
  const procedure = t.procedure.use(caseConvertOutput);
  return t.router({
    plain: procedure.query(() => ({ user_id: '1', command_pattern: 'p' })),
    nested: procedure.query(() => ({
      outer_key: { inner_key: { leaf_key: 'v' } },
      list_of_rows: [{ row_id: 'a' }, { row_id: 'b' }],
    })),
    valuesUnchanged: procedure.query(() => ({ status: 'in_progress' })),
    throwsBusinessError: procedure.query(() => {
      throw new Error('boom');
    }),
    withDate: procedure.query(() => ({ created_at: new Date('2026-05-04') })),
  });
};

describe('case-convert middleware', () => {
  it('converts snake_case keys in query output to camelCase', async () => {
    const caller = buildTestRouter().createCaller({});
    const out = await caller.plain();
    expect(out).toEqual({ userId: '1', commandPattern: 'p' });
  });

  it('walks nested objects and arrays', async () => {
    const caller = buildTestRouter().createCaller({});
    const out = await caller.nested();
    expect(out).toEqual({
      outerKey: { innerKey: { leafKey: 'v' } },
      listOfRows: [{ rowId: 'a' }, { rowId: 'b' }],
    });
  });

  it('does not transform string values (only keys)', async () => {
    const caller = buildTestRouter().createCaller({});
    const out = await caller.valuesUnchanged();
    expect(out.status).toBe('in_progress');
  });

  it('passes Date instances through by reference', async () => {
    const caller = buildTestRouter().createCaller({});
    const out = (await caller.withDate()) as Record<string, unknown>;
    expect(out.createdAt).toBeInstanceOf(Date);
    expect((out.createdAt as Date).toISOString()).toBe('2026-05-04T00:00:00.000Z');
  });

  it('does not transform error responses', async () => {
    const caller = buildTestRouter().createCaller({});
    await expect(caller.throwsBusinessError()).rejects.toThrow('boom');
  });
});
