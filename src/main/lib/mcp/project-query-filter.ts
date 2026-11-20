/** Project fields the chat agent sees from searchProjects / fetchAllProjects. */
export type ProjectHit = { id: string; name: string; path: string; description: string | null };

const WHITESPACE_REGEX = /\s+/;

/** Every query word must appear (case-insensitive) in the name, description or path; an empty query
 * keeps all rows. In memory: a single-user local DB has few projects. */
export function filterProjectsByQuery(
  rows: Array<{ id: string; name: string; path: string; description: string | null }>,
  query: string,
  limit: number,
): ProjectHit[] {
  const words = query.toLowerCase().split(WHITESPACE_REGEX).filter(Boolean);
  const matched = rows.filter((p) => {
    if (words.length === 0) return true;
    const haystack = `${p.name} ${p.description ?? ''} ${p.path}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
  return matched
    .slice(0, limit)
    .map((p) => ({ id: p.id, name: p.name, path: p.path, description: p.description ?? null }));
}
