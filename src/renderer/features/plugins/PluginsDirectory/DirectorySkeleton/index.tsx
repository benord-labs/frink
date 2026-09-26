import { Skeleton } from '../../../../components/ui/skeleton';
import { DIRECTORY_GRID } from '../DirectoryFrame';

const ROWS = ['a', 'b', 'c', 'd', 'e', 'f'];

export function DirectorySkeleton() {
  return (
    <div role="status" aria-label="Loading plugins" className={`mt-8 ${DIRECTORY_GRID}`}>
      {ROWS.map((key) => (
        <div key={key} className="flex items-center gap-3.5 border-hairline border-b px-2 py-3">
          <Skeleton className="size-10 rounded-xl motion-reduce:animate-none" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3 w-28 motion-reduce:animate-none" />
            <Skeleton className="h-2.5 w-48 max-w-full motion-reduce:animate-none" />
          </div>
          {/* Matches the loaded row's trailing rail: a status mark plus a chevron. */}
          <Skeleton className="size-4 rounded motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}
