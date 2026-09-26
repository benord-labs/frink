import { Progress, type ProgressSegment } from '@benord-labs/frink-primitives';
import { memo, type ReactElement } from 'react';

type Props = {
  queuedCount: number;
  reviewCount: number;
  runningCount: number;
};

export const QueueProgressSummary = memo(function QueueProgressSummary({
  queuedCount,
  reviewCount,
  runningCount,
}: Props): ReactElement {
  const segments: ProgressSegment[] = [
    { key: 'running', label: 'Running', value: runningCount, tone: 'primary' },
    { key: 'review', label: 'Review', value: reviewCount, tone: 'primary-soft' },
    { key: 'queued', label: 'Queued', value: queuedCount, tone: 'muted' },
  ];

  return (
    <Progress segments={segments} legend aria-label="Work queue by state" className="shrink-0" />
  );
});
