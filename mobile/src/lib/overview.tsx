import { createContext, useContext, type ReactNode } from 'react';
import { useResource } from './connection';

type Overview = ReturnType<typeof useOverviewResource>;
const OverviewContext = createContext<Overview | null>(null);

function useOverviewResource() {
  return useResource({ type: 'overview', confirmsSideEffects: true });
}

/** One overview poll for the whole tab bar: the Queue badge, the Queue tab and Settings share it. */
export function OverviewProvider({ children }: { children: ReactNode }) {
  const overview = useOverviewResource();
  return <OverviewContext.Provider value={overview}>{children}</OverviewContext.Provider>;
}

export function useOverview(): Overview {
  const value = useContext(OverviewContext);
  if (!value) throw new Error('OverviewProvider is missing');
  return value;
}
