import { beforeEach, expect, it, vi } from 'vitest';

// Deliberately defer render after ensureTarget resolves, reproducing slow React publication.
const render = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as (() => void)[],
  ensure: vi.fn(),
  upload: vi.fn(),
}));
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const index = render.cursor++;
    if (!(index in render.slots)) render.slots[index] = initial;
    return [
      render.slots[index],
      (next: unknown) => {
        render.slots[index] = typeof next === 'function' ? next(render.slots[index]) : next;
      },
    ];
  },
  useRef: (current: unknown) => {
    const index = render.cursor++;
    if (!(index in render.slots)) render.slots[index] = { current };
    return render.slots[index];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
    const index = render.cursor++;
    const previous = render.slots[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (previous?.deps.every((value, i) => Object.is(value, deps[i]))) return;
    render.effects.push(() => {
      previous?.cleanup?.();
      render.slots[index] = { deps, cleanup: effect() };
    });
  },
}));
vi.mock('expo', () => ({ requireOptionalNativeModule: () => null }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('../../../lib/connection', () => ({ useConnection: () => ({ connection: {} }) }));
vi.mock('../../../lib/api', () => ({ uploadAttachment: render.upload }));
vi.mock('expo-document-picker', () => ({
  getDocumentAsync: async () => ({
    canceled: false,
    assets: [{ uri: 'file:notes', name: 'notes.txt', mimeType: 'text/plain' }],
  }),
}));

import { useComposerAttachments } from './use-attachments';

const target = { chatId: 'new-chat', subChatId: 'new-sub' };
function draw(destination: typeof target | null, { runEffects = true } = {}) {
  render.cursor = 0;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- Controlled render timing is the regression.
  const value = useComposerAttachments(destination, {
    retainPicked: true,
    ensureTarget: render.ensure,
  });
  if (runEffects) for (const effect of render.effects.splice(0)) effect();
  return value;
}
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
beforeEach(() => {
  render.cursor = 0;
  render.slots = [];
  render.effects = [];
  render.ensure.mockReset().mockResolvedValue(target);
  render.upload.mockReset().mockResolvedValue({ id: 'stored-1', kind: 'file' });
});

it('uploads once after a lazily created chat publishes through React', async () => {
  await draw(null).pickFiles();
  draw(null);
  await flush();
  expect(render.ensure).toHaveBeenCalledTimes(1);
  // A prepared destination is not a published destination: no orphan upload before the reset.
  expect(render.upload).not.toHaveBeenCalled();
  draw(target);
  draw(target);
  await flush();
  expect(render.upload).toHaveBeenCalledTimes(1);
  expect(draw(target).ids).toEqual(['stored-1']);
  await flush();
  expect(render.upload).toHaveBeenCalledTimes(1);
});

it('does not upload a file again when a stale render flushes after its upload settles', async () => {
  let settle!: (stored: { id: string; kind: 'file' }) => void;
  render.upload.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
  await draw(target).pickFiles();
  draw(target);
  await flush();
  expect(render.upload).toHaveBeenCalledTimes(1);
  // React rendered while the upload was in flight but has not flushed that render's effects yet.
  draw(target, { runEffects: false });
  settle({ id: 'stored-1', kind: 'file' });
  await flush();
  for (const effect of render.effects.splice(0)) effect();
  await flush();
  expect(render.upload).toHaveBeenCalledTimes(1);
  expect(draw(target).ids).toEqual(['stored-1']);
});

// Settled uploads keep their key; a destination change must still free them to upload again.
it('uploads a settled file once more to a new destination after the target changes', async () => {
  const other = { chatId: 'other-chat', subChatId: 'other-sub' };
  await draw(target).pickFiles();
  draw(target);
  await flush();
  expect(draw(target).ids).toEqual(['stored-1']);
  render.upload.mockResolvedValueOnce({ id: 'stored-2', kind: 'file' });
  draw(other);
  draw(other);
  await flush();
  expect(render.upload).toHaveBeenCalledTimes(2);
  expect(render.upload.mock.calls[1][1]).toEqual(other);
  expect(draw(other).ids).toEqual(['stored-2']);
  await flush();
  expect(render.upload).toHaveBeenCalledTimes(2);
});

// A failed upload keeps its key too; retrying must replace it and send exactly once.
it('retries a failed upload exactly once', async () => {
  render.upload.mockRejectedValueOnce(new Error('Mac went to sleep'));
  await draw(target).pickFiles();
  draw(target);
  await flush();
  const [failed] = draw(target).items;
  expect(failed).toMatchObject({ status: 'failed', error: 'Mac went to sleep' });
  draw(target).retry(failed.key);
  await flush();
  draw(target);
  await flush();
  expect(render.upload).toHaveBeenCalledTimes(2);
  expect(draw(target).ids).toEqual(['stored-1']);
});
