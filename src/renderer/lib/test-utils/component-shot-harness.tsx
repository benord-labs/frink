import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Operation } from '@trpc/client';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { ThemeProvider } from 'next-themes';
import type { ComponentType } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { trpc } from '@/lib/trpc';
import { inProcessTrpcLink } from './in-process-trpc-link';

// Renders one component for scripts/qa/component-shot.ts. The script copies this file and
// in-process-trpc-link.ts into the base checkout too, so it may import only packages and `@/lib/trpc`.

type ShotJson = string | number | boolean | null | ShotJson[] | { [key: string]: ShotJson };
type ShotJsonObject = { [key: string]: ShotJson };

export type ComponentShotOptions = {
  props: ShotJsonObject;
  /** Answers keyed by tRPC procedure path (`worktreeConfig.get`), returned whatever the input. */
  fixture: ShotJsonObject;
  theme: 'dark' | 'light';
};

export type ComponentShotState = {
  /** Procedure paths the component called that the fixture has no answer for. */
  missing: string[];
  settled: Promise<void>;
};

function answerFromFixture(fixture: ShotJsonObject, missing: string[]) {
  return (op: Operation): Promise<ShotJson> => {
    if (Object.hasOwn(fixture, op.path)) return Promise.resolve(fixture[op.path]);
    if (!missing.includes(op.path)) missing.push(op.path);
    return Promise.reject(new Error(`component-shot: no fixture for ${op.path}`));
  };
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Resolves once nothing is fetching or mutating, results are delivered, fonts are loaded and two frames have painted. */
async function whenSettled(queryClient: QueryClient): Promise<void> {
  await nextFrame();
  await nextFrame();
  while (queryClient.isFetching() > 0 || queryClient.isMutating() > 0) await nextFrame();
  // React Query hands results to components in a setTimeout(0) batch, after isFetching drops.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await document.fonts?.ready;
  await nextFrame();
  await nextFrame();
}

export function mountComponentShot(
  container: HTMLElement,
  Component: ComponentType<ShotJsonObject>,
  { props, fixture, theme }: ComponentShotOptions,
): ComponentShotState {
  const missing: string[] = [];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = trpc.createClient({
    links: [inProcessTrpcLink(answerFromFixture(fixture, missing))],
  });
  const root = createRoot(container);
  // Mounted and fetching before whenSettled first looks, so it never sees an idle, unrendered tree.
  flushSync(() =>
    root.render(
      <JotaiProvider store={createStore()}>
        <ThemeProvider attribute="class" forcedTheme={theme} disableTransitionOnChange>
          <TooltipProvider delayDuration={100}>
            <trpc.Provider client={client} queryClient={queryClient}>
              <QueryClientProvider client={queryClient}>
                <div id="shot-root" className="bg-background p-6 text-foreground">
                  <Component {...props} />
                </div>
              </QueryClientProvider>
            </trpc.Provider>
          </TooltipProvider>
        </ThemeProvider>
      </JotaiProvider>,
    ),
  );
  return { missing, settled: whenSettled(queryClient) };
}
