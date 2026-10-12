import type { ReactNode } from 'react';
import { Atmosphere } from './material';

// No view wraps the page: iOS only links its bars to a scroll view at the screen's root.
/** Every routed screen: the flat page, or the atmosphere behind a chat. */
export function Screen({
  children,
  atmosphere = false,
}: {
  children: ReactNode;
  atmosphere?: boolean;
}) {
  return (
    <>
      {atmosphere && <Atmosphere />}
      {children}
    </>
  );
}
