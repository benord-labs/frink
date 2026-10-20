import { createContext, type ReactNode } from 'react';
import type { FileLinkTarget } from './file-link-target';

/** A file reference in rendered markdown: its target, the text the markdown showed for it, and the
 * parent folders that tell it from a same-name file in the same reply. */
export type FileReference = FileLinkTarget & { label: string; suffix?: string };

/** The badge renderer a surface offers its markdown; null on surfaces that keep file references as written. */
export const FileLinkBadgeContext = createContext<((reference: FileReference) => ReactNode) | null>(
  null,
);
