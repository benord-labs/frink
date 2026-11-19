import type { MobileRequest } from '@frink/shared/types/remote/mobile';

/** How many chats the Chats screen loads first; its prefetch must ask for the same page. */
export const CHATS_PAGE = 30;

/** The first request the Chats and Flows screens make, prefetched so their first open draws at once. */
export const FIRST_PAGES: MobileRequest[] = [
  { type: 'chats', limit: CHATS_PAGE },
  { type: 'flows' },
];
