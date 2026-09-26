import { createContext, useContext } from 'react';

export const ModifiedFilterContext = createContext(false);

export function useModifiedFilter(): boolean {
  return useContext(ModifiedFilterContext);
}
