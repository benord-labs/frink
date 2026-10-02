/** A paused queue holds every row, resumes included; `null` (setting unknown) claims neither state. */
export function admissionWaitCopy(
  priorityClass: 'resume' | 'start',
  queuePaused: boolean | null,
): { description: string; statusLabel: string } {
  if (queuePaused) {
    return { description: 'On hold until you resume the queue', statusLabel: 'On hold' };
  }
  if (queuePaused === null) return { description: 'In the queue', statusLabel: 'Queued' };
  return priorityClass === 'resume'
    ? { description: 'Waiting to resume', statusLabel: 'Queued to resume' }
    : { description: 'Waiting to start', statusLabel: 'Queued to start' };
}
