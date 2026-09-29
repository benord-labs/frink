import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { z } from 'zod';

/** What the last new chat was started with, so the next one starts the same way. */
const schema = z.object({
  projectId: z.string().nullable(),
  useWorktree: z.boolean(),
  mode: z.enum(['agent', 'plan']),
});
export type NewChatPreferences = z.infer<typeof schema>;
export const DEFAULT_PREFERENCES: NewChatPreferences = {
  projectId: null,
  useWorktree: true,
  mode: 'agent',
};

const KEY = 'frink.mobile.new-chat.v1';
// Browser previews keep choices for this tab only, like the pairing in storage.web.ts.
const web = Platform.OS === 'web';

export async function readPreferences(): Promise<NewChatPreferences> {
  try {
    const saved = web ? sessionStorage.getItem(KEY) : await SecureStore.getItemAsync(KEY);
    const parsed = schema.safeParse(JSON.parse(saved ?? 'null'));
    return parsed.success ? parsed.data : DEFAULT_PREFERENCES;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

/** Best effort: a choice that fails to save only means the next chat starts from the defaults. */
export async function savePreferences(value: NewChatPreferences): Promise<void> {
  const json = JSON.stringify(value);
  try {
    if (web) sessionStorage.setItem(KEY, json);
    else await SecureStore.setItemAsync(KEY, json);
  } catch {}
}
