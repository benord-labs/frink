import { useCallback, useState } from 'react';

/** A growing list window: the phone re-polls the first `limit` rows and raises it to see more. */
export function useWindow(initial: number, step = initial, max = 200) {
  const [limit, setLimit] = useState(initial);
  const more = useCallback(() => setLimit((value) => Math.min(max, value + step)), [max, step]);
  const reset = useCallback(() => setLimit(initial), [initial]);
  return { limit, more, reset, atMax: limit >= max };
}
