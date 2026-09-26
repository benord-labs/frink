import { type ReactNode, useCallback, useState } from 'react';
import { cn } from '../../lib/utils';

/**
 * GitHub owner avatar with a loading placeholder. Renders `errorFallback` if the image
 * fails to load (e.g. owner has no avatar, offline). Callers decide whether an avatar
 * should be attempted at all (provider/owner checks) before rendering this.
 */
export function GitHubAvatar({
  gitOwner,
  className = 'h-4 w-4',
  errorFallback,
}: {
  gitOwner: string;
  className?: string;
  errorFallback: ReactNode;
}) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);

  const handleLoad = useCallback(() => setIsLoaded(true), []);
  const handleError = useCallback(() => setHasError(true), []);

  if (hasError) return <>{errorFallback}</>;

  return (
    <div className={cn(className, 'relative shrink-0')}>
      {/* Placeholder background while loading */}
      {!isLoaded && <div className="absolute inset-0 rounded-sm bg-muted" />}
      <img
        src={`https://github.com/${gitOwner}.png?size=64`}
        alt={gitOwner}
        className={cn(className, 'rounded-sm shrink-0', isLoaded ? 'opacity-100' : 'opacity-0')}
        onLoad={handleLoad}
        onError={handleError}
      />
    </div>
  );
}
