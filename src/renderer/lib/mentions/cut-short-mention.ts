import { toast } from 'sonner';
import { isWholeMentionId } from '../../../shared/lib/mentions/mention-grammar';

/** Why the @ menu can't attach a name the token grammar would cut short. */
export const CUT_SHORT_MENTION_REASON = "Can't attach: square brackets in its name";

/** Whether the mention's token would read back as a shorter id, sending the chat a different path. */
export function isCutShortMention(option: { id: string }): boolean {
  return !isWholeMentionId(option.id);
}

/** Tells the user a cut-short name was not added, for the @ menu and the file tree alike. */
export function toastCutShortMention(option: { label: string; type?: string }) {
  const isPath = option.type === 'file' || option.type === 'folder';
  toast.error(
    `Couldn't add ${option.label}: its name has square brackets a message can't hold.${isPath ? ' Type its path instead.' : ''}`,
  );
}
