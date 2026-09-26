/**
 * Format a timestamp as a relative time string (e.g., "5m", "3h", "2d")
 * Used for displaying chat timestamps in a compact format
 */
export function formatTimeAgo(timestamp: Date | string | undefined): string {
  if (!timestamp) return 'now';

  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const now = new Date();
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diff < 60) return 'now';

  const years = Math.floor(diff / (60 * 60 * 24 * 365));
  const months = Math.floor((diff % (60 * 60 * 24 * 365)) / (60 * 60 * 24 * 30));
  const days = Math.floor((diff % (60 * 60 * 24 * 30)) / (60 * 60 * 24));
  const hours = Math.floor((diff % (60 * 60 * 24)) / (60 * 60));
  const minutes = Math.floor((diff % (60 * 60)) / 60);

  if (years > 0) return `${years}y`;
  if (months > 0) return `${months}mo`;
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return 'now';
}
