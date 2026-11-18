import { createContext, useContext } from 'react';

/** True in the tree of a project linked to the chat: its rows can't be dragged or dropped on,
 *  and their menus offer nothing that changes the project. */
export const ReadOnlyContext = createContext(false);

export function useReadOnlyTree(): boolean {
  return useContext(ReadOnlyContext);
}
