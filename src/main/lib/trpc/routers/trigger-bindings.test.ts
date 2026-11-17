import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '../index';

const { createBindingMock, getBindingByIdMock, updateTriggerBindingMock, deleteBindingMock } =
  vi.hoisted(() => ({
    createBindingMock: vi.fn(),
    getBindingByIdMock: vi.fn(),
    updateTriggerBindingMock: vi.fn(),
    deleteBindingMock: vi.fn(),
  }));

vi.mock('../../db', () => ({
  getDatabase: vi.fn(() => ({})),
}));

vi.mock('../../db/repos/flow-trigger-bindings', async () => {
  const actual = await vi.importActual<typeof import('../../db/repos/flow-trigger-bindings')>(
    '../../db/repos/flow-trigger-bindings',
  );
  return {
    ...actual,
    create: createBindingMock,
    getById: getBindingByIdMock,
    update: updateTriggerBindingMock,
    deleteBinding: deleteBindingMock,
  };
});

import { triggerBindingsRouter } from './trigger-bindings';

type TriggerBindingsCaller = ReturnType<typeof triggerBindingsRouter.createCaller>;

const caller: TriggerBindingsCaller = triggerBindingsRouter.createCaller({
  getWindow: () => null,
} satisfies Context);

const bindingId = '550e8400-e29b-41d4-a716-446655440000';
const postTaskConfig = { triggerStates: ['done', 'completed'], filterBySource: ['manual'] };

describe('triggerBindingsRouter create', () => {
  beforeEach(() => {
    createBindingMock.mockReset();
    createBindingMock.mockResolvedValue({ id: bindingId, triggerType: 'post_task_trigger' });
  });

  const bindingScope = { flowId: 'flow-1', projectId: 'project-1' };

  it('stores the config the post-task editor sends', async () => {
    await caller.create({
      ...bindingScope,
      triggerType: 'post_task_trigger',
      config: { triggerStates: ['done', 'completed'], filterBySource: ['manual'] },
    });

    expect(createBindingMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ triggerType: 'post_task_trigger', config: postTaskConfig }),
    );
  });

  it('accepts the "all statuses" state and a schedule binding with no config fields', async () => {
    await caller.create({
      ...bindingScope,
      triggerType: 'post_task_trigger',
      config: { triggerStates: ['all'] },
    });
    await caller.create({ ...bindingScope, triggerType: 'schedule_trigger', config: {} });

    expect(createBindingMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['post_task_trigger', { wrong: 'shape' }],
    ['post_task_trigger', {}],
    ['post_task_trigger', { triggerStates: 'done' }],
    ['post_task_trigger', { triggerStates: ['bogus'] }],
    ['post_task_trigger', { triggerStates: [] }],
    ['post_task_trigger', { triggerStates: ['done'], extra: true }],
    ['post_task_trigger', { triggerStates: ['done'], filterBySource: 'manual' }],
    ['schedule_trigger', { wrong: 'shape' }],
    ['schedule_trigger', { cronExpression: 123 }],
    ['schedule_trigger', { triggerStates: ['done'] }],
    ['webhook_trigger', {}],
  ])('rejects a %s binding with config %j without storing it', async (triggerType, config) => {
    // SAFETY: every row is deliberately outside the input type; the router must reject it at runtime.
    const invalidInput = { ...bindingScope, triggerType, config } as never;

    await expect(caller.create(invalidInput)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(createBindingMock).not.toHaveBeenCalled();
  });
});

describe('triggerBindingsRouter update', () => {
  beforeEach(() => {
    updateTriggerBindingMock.mockReset();
    updateTriggerBindingMock.mockResolvedValue({ id: bindingId });
    getBindingByIdMock.mockReset();
    getBindingByIdMock.mockResolvedValue({ id: bindingId, triggerType: 'post_task_trigger' });
  });

  it('rejects input with only id (empty patch)', async () => {
    await expect(caller.update({ id: bindingId })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(updateTriggerBindingMock).not.toHaveBeenCalled();
  });

  it('allows isActive: false as a meaningful patch', async () => {
    await caller.update({ id: bindingId, isActive: false });

    expect(updateTriggerBindingMock).toHaveBeenCalledWith(
      expect.anything(),
      bindingId,
      expect.objectContaining({ isActive: false }),
    );
  });

  it('rejects clearLastError: false (only `true` is a meaningful patch)', async () => {
    await expect(caller.update({ id: bindingId, clearLastError: true })).resolves.toBeDefined();
    expect(updateTriggerBindingMock).toHaveBeenCalledWith(
      expect.anything(),
      bindingId,
      expect.objectContaining({ clearLastError: true }),
    );
  });

  it('does not read the stored binding when the patch carries no config', async () => {
    await caller.update({ id: bindingId, isActive: false });

    expect(getBindingByIdMock).not.toHaveBeenCalled();
  });

  it('stores a config that matches the stored binding type', async () => {
    await caller.update({ id: bindingId, config: postTaskConfig, clearLastError: true });

    expect(updateTriggerBindingMock).toHaveBeenCalledWith(
      expect.anything(),
      bindingId,
      expect.objectContaining({ config: postTaskConfig, clearLastError: true }),
    );
  });

  it.each([[{}], [{ wrong: 'shape' }], [{ triggerStates: ['bogus'] }]])(
    'rejects config %j on a post-task binding without writing it',
    async (config) => {
      await expect(caller.update({ id: bindingId, config })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Config does not match what a post_task_trigger binding expects',
      });
      expect(updateTriggerBindingMock).not.toHaveBeenCalled();
    },
  );

  it('rejects a post-task config on a schedule binding', async () => {
    getBindingByIdMock.mockResolvedValue({ id: bindingId, triggerType: 'schedule_trigger' });

    await expect(caller.update({ id: bindingId, config: postTaskConfig })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(updateTriggerBindingMock).not.toHaveBeenCalled();
  });

  it('reports a missing binding without writing when the patch carries config', async () => {
    getBindingByIdMock.mockResolvedValue(null);

    await expect(caller.update({ id: bindingId, config: postTaskConfig })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(updateTriggerBindingMock).not.toHaveBeenCalled();
  });

  it('reports a missing binding when it is deleted between the type check and the write', async () => {
    updateTriggerBindingMock.mockResolvedValue(null);

    await expect(caller.update({ id: bindingId, config: postTaskConfig })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('triggerBindingsRouter delete', () => {
  beforeEach(() => {
    deleteBindingMock.mockReset();
  });

  it('succeeds when the binding is already gone (double-click / stale id)', async () => {
    deleteBindingMock.mockResolvedValue(false);

    await expect(caller.delete({ id: bindingId })).resolves.toEqual({ ok: true });
  });

  it('succeeds when the binding is removed', async () => {
    deleteBindingMock.mockResolvedValue(true);

    await expect(caller.delete({ id: bindingId })).resolves.toEqual({ ok: true });
    expect(deleteBindingMock).toHaveBeenCalledWith(expect.anything(), bindingId);
  });

  it('rejects an empty id without touching the database', async () => {
    await expect(caller.delete({ id: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(deleteBindingMock).not.toHaveBeenCalled();
  });

  it('still rejects when the database delete fails', async () => {
    deleteBindingMock.mockRejectedValue(new Error('SQLITE_BUSY'));

    await expect(caller.delete({ id: bindingId })).rejects.toThrow('SQLITE_BUSY');
  });
});
