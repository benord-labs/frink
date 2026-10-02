import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '../index';

const { updateTriggerBindingMock, deleteBindingMock } = vi.hoisted(() => ({
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

describe('triggerBindingsRouter update', () => {
  beforeEach(() => {
    updateTriggerBindingMock.mockReset();
    updateTriggerBindingMock.mockResolvedValue({ id: bindingId });
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

  it('allows config: {} as a patch', async () => {
    await caller.update({ id: bindingId, config: {} });

    expect(updateTriggerBindingMock).toHaveBeenCalledWith(
      expect.anything(),
      bindingId,
      expect.objectContaining({ config: {} }),
    );
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
