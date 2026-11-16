import { Files } from 'lucide-react';
import type { ComponentType } from 'react';
import { fileTypeIcon } from '../../../shared/lib/file-type-icons';
import { iconifyComponent } from '../utils/iconify-component';

type FileIconComponent = ComponentType<{ className?: string }>;

/** File icon component based on file extension (no mention UI / data fetching). */
export function getFileIconByExtension(
  filename: string,
  returnNullForUnknown: true,
): FileIconComponent | null;
export function getFileIconByExtension(
  filename: string,
  returnNullForUnknown?: false,
): FileIconComponent;
export function getFileIconByExtension(
  filename: string,
  returnNullForUnknown?: boolean,
): FileIconComponent | null {
  const icon = fileTypeIcon(filename);
  if (icon) return iconifyComponent(icon);
  return returnNullForUnknown === true ? null : Files;
}
