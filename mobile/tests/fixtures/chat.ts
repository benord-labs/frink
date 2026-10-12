import { expect, type Page } from '@playwright/test';
import type { MobileChatDetail } from '@frink/shared/types/remote/mobile';
import type { AppState } from './app';
import { chatFixture } from './data';
import { openHistory } from './navigation';

/** The fixture chat, idle unless asked otherwise, with any fields replaced. */
export function conversation(
  overrides: Partial<MobileChatDetail> = {},
  activity: MobileChatDetail['activity'] = 'idle',
): MobileChatDetail {
  return { ...chatFixture(activity), ...overrides };
}

/** Opens a conversation through the same History row the reader uses. */
export async function openChat(page: Page, { id = 'chat-1' } = {}) {
  await openHistory(page);
  await page.getByTestId(`chat-row-${id}`).click();
  await expect(page.getByRole('button', { name: 'Chat options', exact: true })).toBeVisible();
}

/**
 * Scrolls the transcript like a reader once its first layout has settled; scrolling while
 * markdown is still measuring would race the follow-to-latest correction.
 */
export async function scrollTranscript(page: Page, top: number) {
  const transcript = page.getByTestId('chat-transcript');
  const height = () => transcript.evaluate((node) => node.scrollHeight);
  await expect
    .poll(async () => {
      const before = await height();
      await page.waitForTimeout(250);
      return before === (await height());
    })
    .toBe(true);
  await transcript.dispatchEvent('pointerdown');
  await transcript.evaluate((node, value) => (node.scrollTop = value), top);
}

export const requestsOf = (state: AppState, type: string) =>
  state.requests.filter((request) => request.type === type);

export const messageBox = (page: Page) =>
  page.getByRole('textbox', { name: 'Message', exact: true });
