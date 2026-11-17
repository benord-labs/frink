import fs from 'node:fs';
import log from 'electron-log';
import type { getDatabase } from '../../../db';
import { listLinkedProjectRoots, overlapsAny } from '../../../db/repos/chat-linked-projects';
import { getProjectDoc } from '../../../permissions/v2/store-local';
import type { LinkedRoot, PermissionsDoc } from '../../../permissions/v2/types';

type Db = ReturnType<typeof getDatabase>;

/** A linked project's own rules, or null when they cannot be read, so its reads ask. */
async function loadDoc(db: Db, projectId: string): Promise<PermissionsDoc | null> {
  try {
    return await getProjectDoc(db, projectId);
  } catch (err) {
    log.warn("[permissions] Could not load a linked project's rules — reads there will ask", err);
    return null;
  }
}

/**
 * The projects linked to the chat, with their own rules, for the permission gate. Read on
 * every call, so an unlink applies to the very next read. A folder that is gone, or that is,
 * holds or sits inside the chat's own folder, is left out. A project whose rules cannot be read
 * keeps a null doc rather than being left out, so a link nested inside it cannot step around them.
 * When the links cannot be read at all there are none, and reads outside the chat's folder ask.
 */
export async function loadLinkedRoots(
  db: Db,
  chatId: string,
  projectPath: string,
): Promise<LinkedRoot[]> {
  let links: ReturnType<typeof listLinkedProjectRoots>;
  try {
    links = listLinkedProjectRoots(db, chatId).filter(
      (link) => fs.existsSync(link.path) && !overlapsAny(link.path, [projectPath]),
    );
  } catch (err) {
    log.warn("[permissions] Could not read the chat's linked projects — reads there will ask", err);
    return [];
  }
  return Promise.all(
    links.map(async (link) => ({ ...link, doc: await loadDoc(db, link.projectId) })),
  );
}
