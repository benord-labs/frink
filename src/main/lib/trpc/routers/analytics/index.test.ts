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

it('accepts a cancelled connect reported as a provider id', async () => {
  await expect(
    caller.accountConnectCancelled({ provider: 'codex', reason: 'cancelled' }),
  ).resolves.toBeUndefined();
});

it.each([
  { provider: 'my-work-account', reason: 'cancelled' },
  { provider: 'codex', reason: 'not_signed_in' },
  { provider: 'codex', reason: 'Codex login expired for me@example.com' },
  { provider: 'codex', reason: 'cancelled', email: 'me@example.com' },
  { provider: 'codex' },
])('rejects a cancelled-connect report that is not just the two enums: %o', async (report) => {
  // SAFETY: deliberately malformed input, to prove the router's schema rejects it at runtime
  await expect(caller.accountConnectCancelled(report as never)).rejects.toThrow();
});
