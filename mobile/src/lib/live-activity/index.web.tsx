import type { ReactNode } from 'react';

// Browser previews have no Lock Screen, so there is no card and no switch for it.
export function LiveActivityProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
export function useLiveActivity(): null {
  return null;
}
