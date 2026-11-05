import { createContext, useContext } from 'react';

/** True in the tree of another project being browsed: its rows can't be dragged or dropped on,
 *  and their menus offer nothing that changes the project. */
export const ReadOnlyContext = createContext(false);

export function useReadOnlyTree(): boolean {
  return useContext(ReadOnlyContext);
}
