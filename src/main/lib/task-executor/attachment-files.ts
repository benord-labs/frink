/** Run files reach the agent as copies in the chat's `pasted/` folder (read without a prompt). */

import { basename } from 'node:path';
import { z } from 'zod';
import { RUN_ATTACHMENT_FILE_TYPE } from '../../../shared/types/run-attachment';
import type { TaskResultRecord } from '../../../shared/types/task-result';
import { attachedFileNote, placeInPasted, safeAttachmentName } from '../claude/pasted-files';
import { attachmentFilePath } from '../flows/attachments-storage';

const fileEntrySchema = z.object({
  url: z.string(),
  type: z.literal(RUN_ATTACHMENT_FILE_TYPE),
  label: z.string().min(1).optional(),
});
type FileEntry = z.infer<typeof fileEntrySchema>;

const attachmentListSchema = z.object({ attachments: z.array(z.json()).catch([]) });

function fileEntries(triggerContext: TaskResultRecord | undefined): FileEntry[] {
  const list = attachmentListSchema.safeParse(triggerContext);
  if (!list.success) return [];
  return list.data.attachments.flatMap((item) => {
    const entry = fileEntrySchema.safeParse(item);
    return entry.success ? [entry.data] : [];
  });
}

/** The stored name keeps only ASCII; the copy the agent reads keeps the real name, behind the
 *  stored name's unique prefix so a second hand-over finds the same copy. */
function pastedName(storedName: string, name: string | undefined): string {
  if (!name) return storedName;
  return `${storedName.slice(0, storedName.indexOf('-') + 1)}${safeAttachmentName(name)}`;
}

type Delivery = { note: string } | { warning: string };
/** Where run uploads and chat folders live; the app's own folders when omitted. */
type DeliveryDirs = { attachmentsRoot?: string; userData?: string };

async function deliverOne(
  entry: FileEntry,
  subChatId: string,
  dirs: DeliveryDirs,
): Promise<Delivery> {
  const shown = entry.label ?? entry.url;
  // Only a file stored on this run may be copied: a trigger context can carry any URL.
  const source = attachmentFilePath(entry.url, dirs.attachmentsRoot);
  if (!source) {
    return {
      warning: `⚠️ Attached file "${shown}" was not sent: it is not a file uploaded to the run.`,
    };
  }
  const filename = pastedName(basename(source), entry.label);
  return placeInPasted({ subChatId, sourcePath: source, filename }, dirs.userData).then(
    (copy) => ({ note: attachedFileNote(copy) }),
    () => ({
      warning: `⚠️ Attached file "${shown}" was not sent: Frink could not read it on this computer. Upload it again.`,
    }),
  );
}

/** The prompt's read-it notes for the run's files ('' when none); a failed file adds a warning. */
export async function attachmentFileNotes(
  triggerContext: TaskResultRecord | undefined,
  subChatId: string,
  promptWarnings: string[],
  dirs: DeliveryDirs = {},
): Promise<string> {
  const deliveries = await Promise.all(
    fileEntries(triggerContext).map((entry) => deliverOne(entry, subChatId, dirs)),
  );
  const notes: string[] = [];
  for (const delivery of deliveries) {
    if ('note' in delivery) notes.push(delivery.note);
    else promptWarnings.push(delivery.warning);
  }
  return notes.length > 0 ? `\n\n${notes.join('\n')}` : '';
}
