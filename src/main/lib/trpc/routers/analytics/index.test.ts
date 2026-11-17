import { expect, it, vi } from 'vitest';
import * as analytics from '../../../analytics';
import { analyticsRouter } from '.';

const caller = analyticsRouter.createCaller({ getWindow: () => null });
const message = { workspaceId: 'mg4x2k9qabcdefgh', messageLength: 5, mode: 'agent' as const };

it('accepts a message report made of an id, a length and a mode', async () => {
  await expect(caller.messageSent(message)).resolves.toBeUndefined();
});

it("records a renderer's report as a later message, never a chat's first", async () => {
  const trackMessageSent = vi.spyOn(analytics, 'trackMessageSent');

  await caller.messageSent(message);

  expect(trackMessageSent).toHaveBeenCalledWith({ ...message, startsChat: false });
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
