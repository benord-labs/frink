import { CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import { memo } from 'react';
import { Spinner } from '../../../../components/ui/spinner';

export const NodeRunStatusIcon = memo(function NodeRunStatusIcon({ status }: { status: string }) {
  if (status === 'completed') {
    return <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" aria-hidden />;
  }
  if (status === 'failed') {
    return <XCircle className="h-3 w-3 shrink-0 text-destructive" aria-hidden />;
  }
  if (status === 'running') {
    return <Spinner className="h-3 w-3 shrink-0 text-blue-500" />;
  }
  if (status === 'paused') {
    return <Spinner className="h-3 w-3 shrink-0 text-warning" />;
  }
  return <CircleDashed className="h-3 w-3 shrink-0 text-muted-foreground/30" aria-hidden />;
});
