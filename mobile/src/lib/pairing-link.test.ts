import { beforeEach, expect, it, vi } from 'vitest';
const linking = vi.hoisted(() => ({ getInitialURL: vi.fn(), addEventListener: vi.fn() }));
vi.mock('react-native', () => ({ Linking: linking, Platform: { OS: 'ios' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { scheme: 'frink-mobile' } } }));
import { onQueueLink } from './pairing-link';

const remove = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  linking.addEventListener.mockReturnValue({ remove });
});

it('opens the Queue when a tap on the Lock Screen card launched the app', async () => {
  linking.getInitialURL.mockResolvedValue('frink-mobile://queue');
  const open = vi.fn();
  const stop = onQueueLink(open);
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  stop();
  expect(remove).toHaveBeenCalledOnce();
});

it('opens the Queue for a tap while open, and ignores other links', async () => {
  linking.getInitialURL.mockResolvedValue('frink-mobile://pair?code=1');
  const open = vi.fn();
  onQueueLink(open);
  const arrive = linking.addEventListener.mock.calls[0][1];
  arrive({ url: 'frink-mobile://pair?code=2' });
  await Promise.resolve();
  expect(open).not.toHaveBeenCalled();
  arrive({ url: 'frink-mobile://queue' });
  expect(open).toHaveBeenCalledOnce();
});
