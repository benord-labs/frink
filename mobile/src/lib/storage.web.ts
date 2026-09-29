import { connectionSchema, type Connection } from './api';

// Browser previews keep the pairing for this tab only (sessionStorage), never across sessions.
const KEY = 'frink.mobile.connection';
export async function readConnection(): Promise<Connection | null> {
  const parsed = connectionSchema.safeParse(JSON.parse(sessionStorage.getItem(KEY) ?? 'null'));
  return parsed.success ? parsed.data : null;
}
export async function saveConnection(value: Connection | null) {
  if (value) sessionStorage.setItem(KEY, JSON.stringify(value));
  else sessionStorage.removeItem(KEY);
}
