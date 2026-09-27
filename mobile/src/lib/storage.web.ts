import type { Connection } from './api';

// Browser preview deliberately keeps credentials only for this page's lifetime.
let connection: Connection | null = null;
export async function readConnection() {
  return connection;
}
export async function saveConnection(value: Connection | null) {
  connection = value;
}
