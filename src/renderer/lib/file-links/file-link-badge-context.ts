import { createContext, type ReactNode } from 'react';
import type { FileLinkTarget } from './file-link-target';

/** A file reference in rendered markdown: its target and the text the markdown showed for it. */
export type FileReference = FileLinkTarget & { label: string };

/** Draws a file reference in rendered markdown as a badge; without one the original markdown shows. */
export const FileLinkBadgeContext = createContext<((reference: FileReference) => ReactNode) | null>(
  null,
);
