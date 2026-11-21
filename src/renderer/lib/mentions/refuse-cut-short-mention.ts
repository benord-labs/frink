import { toast } from 'sonner';
import { isWholeMentionId } from '../../../shared/lib/mentions/mention-grammar';

/** Whether the token would read back shorter, so the mention is refused and the user told. Only a
 * skill, agent or tool name can be: file and folder paths are encoded (see pathMentionId). */
export function refuseCutShortMention(option: { id: string; label: string }): boolean {
  if (isWholeMentionId(option.id)) return false;
  toast.error(`Couldn't add ${option.label}: its name has square brackets a message can't hold.`);
  return true;
}
