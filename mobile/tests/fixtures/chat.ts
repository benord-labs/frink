import { expect, type Page } from '@playwright/test';
import type { MobileChatDetail } from '../../../src/shared/types/remote/mobile';
import type { AppState } from './app';
import { chatFixture } from './data';

/** The fixture chat, idle unless asked otherwise, with any fields replaced. */
export function conversation(
  overrides: Partial<MobileChatDetail> = {},
  activity: MobileChatDetail['activity'] = 'idle',
): MobileChatDetail {
  return { ...chatFixture(activity), ...overrides };
}

/**
 * Opens a chat as a deep link would: through the navigator the tab bar already holds, so these
 * tests don't depend on the list screens that normally lead here.
 */
export async function openChat(
  page: Page,
  params: { id: string; subChatId?: string; decisionTarget?: { type: string; id: string } } = {
    id: 'chat-1',
  },
) {
  await page.getByTestId('tab-queue').waitFor();
  await page.evaluate((route) => {
    const element = document.querySelector('[data-testid="tab-queue"]') as unknown as Record<
      string,
      { memoizedProps?: { navigation?: { navigate?: (...args: unknown[]) => void } }; return: unknown }
    >;
    const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'))!;
    let fiber = element[key] as (typeof element)[string] | null;
    while (fiber) {
      const navigate = fiber.memoizedProps?.navigation?.navigate;
      if (navigate) return navigate('Chat', route);
      fiber = fiber.return as typeof fiber;
    }
    throw new Error('No navigator found above the tab bar');
  }, params);
  await expect(page.getByTestId('chat-transcript')).toBeVisible();
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
