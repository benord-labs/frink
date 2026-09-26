import { Skeleton } from '../../../../components/ui/skeleton';

/** The loaded page's tiers, so content does not jump a screen when the query resolves. */
export function PluginDetailSkeleton() {
  return (
    <div
      className="space-y-10"
      role="status"
      aria-busy="true"
      aria-label="Loading plugin capabilities"
    >
      <Skeleton className="h-24 w-full max-w-[40rem] motion-reduce:animate-none" />
      <Skeleton className="h-60 w-full rounded-[22px] motion-reduce:animate-none" />
      <div className="space-y-7">
        {['h-28', 'h-36', 'h-24'].map((height) => (
          <Skeleton key={height} className={`${height} w-full motion-reduce:animate-none`} />
        ))}
      </div>
      <Skeleton className="h-40 w-full motion-reduce:animate-none" />
    </div>
  );
}
