/**
 * Generate a unique ID (cuid-like)
 */
export function createId(): string {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 10);
  return `${timestamp}${randomPart}`;
}

/** SQLite's extended result code for a duplicate primary key. */
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;

/** True when an insert failed on a duplicate primary key. Drizzle wraps the driver's error as
 *  `cause`, so the whole chain is checked. */
export function isPrimaryKeyConflict(err: Error): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if ('errcode' in e && e.errcode === SQLITE_CONSTRAINT_PRIMARYKEY) return true;
  }
  return false;
}
