/** Type guard for project rows returned by `trpc.projects.list`. */
export function isProjectRow(value: unknown): value is { id: string; name: string; path: string } {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.name === 'string' && typeof o.path === 'string';
}
