import { expect, it } from 'vitest';
import { analyticsRouter } from '.';

const caller = analyticsRouter.createCaller({ getWindow: () => null });
const message = { workspaceId: 'mg4x2k9qabcdefgh', messageLength: 5, mode: 'agent' as const };

it('accepts a message report made of an id, a length and a mode', async () => {
  await expect(caller.messageSent(message)).resolves.toBeUndefined();
});

it.each([
  { ...message, workspaceId: 'a prompt the user typed' },
  { ...message, mode: 'a prompt the user typed' },
  { ...message, messageLength: 'a prompt the user typed' },
  { ...message, text: 'a prompt the user typed' },
])('rejects a message report that could carry content: %o', async (report) => {
  // SAFETY: deliberately malformed input, to prove the router's schema rejects it at runtime
  await expect(caller.messageSent(report as never)).rejects.toThrow();
});
