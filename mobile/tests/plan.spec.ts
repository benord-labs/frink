import { expect as baseExpect, test, type Page } from '@playwright/test';
import type { MobileChatDetail } from '@frink/shared/types/remote/mobile';
import { openApp } from './fixtures/app';
import { conversation, messageBox, openChat, requestsOf } from './fixtures/chat';

const expect = baseExpect.configure({ timeout: 15_000 });

const PLAN = [
  '## Retry failed Stripe webhooks',
  '',
  'Webhook deliveries that fail today are dropped. I’ll retry them with backoff.',
  '',
  '1. Store each failed delivery in a `webhook_retries` table.',
  '2. Retry after 1, 5 and 30 minutes, then give up and alert.',
  '3. Skip events that were already processed, using the event id.',
  '4. Add tests for a delivery that fails twice, then succeeds.',
  '5. Show retries on the admin dashboard.',
  '',
  '### Files',
  '- `billing/webhooks.ts`',
  '- `billing/retry-queue.ts`',
  '- `admin/webhooks-page.tsx`',
].join('\n');

/** The Queue's plan-ready chat: Frink wrote a plan and waits for the reader to decide. */
function planChat(pending = true): MobileChatDetail {
  return conversation({
    chat: { id: 'chat-4', name: 'Plan the Stripe webhook retry fix', projectId: 'project-1' },
    subChatId: 'sub-4',
    subChats: [{ id: 'sub-4', name: 'Plan the Stripe webhook retry fix', activity: 'idle' }],
    messages: [
      {
        id: 'u1',
        role: 'user',
        text: 'Failed Stripe webhooks are lost. Plan a retry fix.',
        parts: [{ type: 'text', text: 'Failed Stripe webhooks are lost. Plan a retry fix.' }],
      },
      {
        id: 'a1',
        role: 'assistant',
        text: 'Here is the plan.',
        parts: [
          { type: 'tool', id: 't1', name: 'Grep', state: 'completed' },
          { type: 'tool', id: 't2', name: 'Read', state: 'completed' },
          { type: 'text', text: 'Here is the plan.' },
          { type: 'plan', id: 'plan-1', text: PLAN },
        ],
      },
    ],
    pendingPlanId: pending ? 'plan-1' : null,
  });
}

const card = (page: Page) => page.getByTestId('message-a1');
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

test.describe('a plan waiting for review', () => {
  for (const scheme of ['dark', 'light'] as const)
    test(`reads as a folded card with Approve and Send back (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await openApp(page, { data: { chat: planChat() } });
      await openChat(page, { id: 'chat-4', subChatId: 'sub-4' });
      await expect(card(page).getByText('Plan ready for your review')).toBeVisible();
      await expect(button(page, 'Approve')).toBeVisible();
      // Deciding is the next step, so the message box steps aside as it does for a question.
      await expect(messageBox(page)).toHaveCount(0);
      await expect(button(page, 'Show more')).toBeVisible();
      await page.screenshot({ path: `test-results/sc4145-plan-ready-${scheme}.png` });
      await button(page, 'Show more').click();
      await expect(button(page, 'Show less')).toBeVisible();
      await page.screenshot({ path: `test-results/sc4145-plan-open-${scheme}.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(errors).toEqual([]);
    });

  test('Approve asks the Mac to build this exact plan', async ({ page }) => {
    const state = await openApp(page, { data: { chat: planChat() } });
    await openChat(page, { id: 'chat-4', subChatId: 'sub-4' });
    await button(page, 'Approve').click();
    await expect.poll(() => requestsOf(state, 'approvePlan').length).toBe(1);
    expect(requestsOf(state, 'approvePlan')[0]).toMatchObject({
      chatId: 'chat-4',
      subChatId: 'sub-4',
      planId: 'plan-1',
      requestId: expect.any(String),
    });
  });

  test('Send back replies with a note, and a refusal is explained', async ({ page }) => {
    const state = await openApp(page, {
      data: { chat: planChat() },
      respond: (input) =>
        input.type === 'approvePlan'
          ? new Error('This plan changed. Refresh to see the latest one.')
          : undefined,
    });
    await openChat(page, { id: 'chat-4', subChatId: 'sub-4' });
    await button(page, 'Approve').click();
    await expect(page.getByText('This plan changed. Refresh to see the latest one.')).toBeVisible();
    await button(page, 'Send back').click();
    // Writing a note leaves one way forward: send it, or cancel.
    await expect(button(page, 'Approve')).toHaveCount(0);
    const note = page.getByRole('textbox', { name: 'What should change' });
    await note.fill('Retry for up to a day, not 30 minutes.');
    await page.screenshot({ path: 'test-results/sc4145-plan-send-back-dark.png' });
    await page.getByRole('button', { name: 'Send back', exact: true }).last().click();
    await expect.poll(() => requestsOf(state, 'sendMessage').length).toBe(1);
    expect(requestsOf(state, 'sendMessage')[0]).toMatchObject({
      chatId: 'chat-4',
      subChatId: 'sub-4',
      text: 'Retry for up to a day, not 30 minutes.',
    });
  });

  test('a decided plan stays readable without actions, and the message box returns', async ({
    page,
  }) => {
    await openApp(page, { data: { chat: planChat(false) } });
    await openChat(page, { id: 'chat-4', subChatId: 'sub-4' });
    await expect(card(page).getByText('Plan', { exact: true })).toBeVisible();
    await expect(button(page, 'Approve')).toHaveCount(0);
    // Copy covers the plan too, so it sits under the card rather than between prose and plan.
    const copyTop = (await button(page, 'Copy message').boundingBox())?.y ?? 0;
    const showMoreTop = (await button(page, 'Show more').boundingBox())?.y ?? Infinity;
    expect(copyTop).toBeGreaterThan(showMoreTop);
    await expect(messageBox(page)).toBeVisible();
    await expect(button(page, 'Show more')).toBeVisible();
    await page.screenshot({ path: 'test-results/sc4145-plan-decided-dark.png' });
  });

  test('the Queue’s Plan ready row opens the plan', async ({ page }) => {
    const state = await openApp(page, { data: { chat: planChat() } });
    await page.getByTestId('queue-row-task-plan').click();
    await expect.poll(() => requestsOf(state, 'chat').some((r) => r.id === 'chat-4')).toBe(true);
    await expect(button(page, 'Approve')).toBeInViewport();
    await page.screenshot({ path: 'test-results/sc4145-plan-from-queue-dark.png' });
  });
});
