import type { FileStatus } from '../../../../shared/changes-types';

/**
 * Get text color for status
 */
export function getStatusColor(status: FileStatus): string {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'text-green-500';
    case 'modified':
      return 'text-yellow-600';
    case 'deleted':
      return 'text-red-500';
    case 'renamed':
      return 'text-blue-500';
    case 'copied':
      return 'text-blue-400';
    default:
      return 'text-muted-foreground';
  }
}

/**
 * Get background color for status (for dot indicators)
 */
export function getStatusBackgroundColor(status: FileStatus): string {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'bg-green-500';
    case 'modified':
      return 'bg-yellow-600';
    case 'deleted':
      return 'bg-red-500';
    case 'renamed':
      return 'bg-blue-500';
    case 'copied':
      return 'bg-blue-400';
    default:
      return 'bg-muted-foreground';
  }
}
