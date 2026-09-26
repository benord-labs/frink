import { CheckCircle2, CircleDashed, Loader2, XCircle } from 'lucide-react';
import { memo } from 'react';

export const NodeRunStatusIcon = memo(function NodeRunStatusIcon({ status }: { status: string }) {
  if (status === 'completed') {
    return <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" aria-hidden />;
  }
  if (status === 'failed') {
    return <XCircle className="h-3 w-3 shrink-0 text-destructive" aria-hidden />;
  }
  if (status === 'running') {
    return <Loader2 className="h-3 w-3 shrink-0 text-blue-500 animate-spin" aria-hidden />;
  }
  if (status === 'paused') {
    return <Loader2 className="h-3 w-3 shrink-0 text-warning animate-spin" aria-hidden />;
  }
  return <CircleDashed className="h-3 w-3 shrink-0 text-muted-foreground/30" aria-hidden />;
});
