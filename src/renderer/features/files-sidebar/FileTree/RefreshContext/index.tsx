import { createContext, useContext } from 'react';

// Context to trigger refetch of all tree nodes when git status changes
export const RefreshContext = createContext<number>(0);

export function useRefreshTrigger() {
  return useContext(RefreshContext);
}
