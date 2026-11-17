import { createContext, type ReactNode } from 'react';

/** Draws a mention id in rendered markdown as a chip; without one the raw token shows. */
export const MentionChipContext = createContext<((id: string) => ReactNode) | null>(null);
