/** Remember a value while retaining at most the newest insertion-ordered entries. */
export function rememberBounded<T>(values: Set<T>, value: T, limit: number): void {
  values.add(value);
  if (values.size <= limit) return;
  const oldest = values.values().next();
  if (!oldest.done) values.delete(oldest.value);
}
