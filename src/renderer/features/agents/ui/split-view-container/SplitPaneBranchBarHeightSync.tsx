import {
  type CSSProperties,
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { SplitLayout } from '../../atoms';
import { maxBranchBarHeightsInGroup } from './branch-bar-sync-row-groups';

type BranchBarSyncContextValue = {
  heightsByPane: Record<number, number>;
  layout: SplitLayout;
  paneCount: number;
  reportHeight: (paneIndex: number, height: number) => void;
  unregister: (paneIndex: number) => void;
};

const SplitPaneBranchBarHeightContext = createContext<BranchBarSyncContextValue | null>(null);

export function SplitPaneBranchBarHeightProvider({
  children,
  layout,
  paneCount,
}: {
  children: ReactNode;
  layout: SplitLayout;
  paneCount: number;
}) {
  const [heightsByPane, setHeightsByPane] = useState<Record<number, number>>({});

  const reportHeight = useCallback((paneIndex: number, height: number) => {
    const q = Math.max(0, Math.round(height));
    setHeightsByPane((prev) => {
      if (prev[paneIndex] === q) return prev;
      return { ...prev, [paneIndex]: q };
    });
  }, []);

  const unregister = useCallback((paneIndex: number) => {
    setHeightsByPane((prev) => {
      if (!(paneIndex in prev)) return prev;
      const { [paneIndex]: _, ...rest } = prev;
      return rest;
    });
  }, []);

  const value = useMemo(
    () => ({ heightsByPane, layout, paneCount, reportHeight, unregister }),
    [heightsByPane, layout, paneCount, reportHeight, unregister],
  );

  return (
    <SplitPaneBranchBarHeightContext.Provider value={value}>
      {children}
    </SplitPaneBranchBarHeightContext.Provider>
  );
}

/**
 * Syncs workspace footer (branch bar) min-height across split panes.
 * Measure the **inner** ref (natural content height); apply shared max on the outer wrapper only.
 * When `enabled` is false (e.g. inactive keep-alive sub-chat tab), does not register.
 */
export function useSplitPaneBranchBarSync(
  paneIndex: number | undefined,
  enabled: boolean,
): {
  measureRef: RefObject<HTMLDivElement | null>;
  outerStyle: CSSProperties | undefined;
} {
  const ctx = useContext(SplitPaneBranchBarHeightContext);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const measureRef = useRef<HTMLDivElement | null>(null);
  const rafIdRef = useRef<number | null>(null);

  // Do not depend on `ctx` identity — provider value changes whenever heights update, which would
  // teardown/re-register ResizeObserver and loop (unregister → report → setState → new ctx).
  useLayoutEffect(() => {
    const c = ctxRef.current;
    if (!c || paneIndex === undefined || !enabled) {
      if (c && paneIndex !== undefined) c.unregister(paneIndex);
      return;
    }

    const el = measureRef.current;
    if (!el) return;

    const flush = () => {
      rafIdRef.current = null;
      const h = Math.round(el.getBoundingClientRect().height);
      c.reportHeight(paneIndex, h);
    };

    const ro = new ResizeObserver(() => {
      if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(flush);
    });

    ro.observe(el);
    flush();

    return () => {
      if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current);
      ro.disconnect();
      c.unregister(paneIndex);
    };
  }, [paneIndex, enabled]);

  const maxHeight =
    ctx && paneIndex !== undefined && enabled
      ? maxBranchBarHeightsInGroup(ctx.heightsByPane, ctx.layout, ctx.paneCount, paneIndex)
      : 0;

  const outerStyle: CSSProperties | undefined =
    maxHeight > 0 ? { minHeight: maxHeight } : undefined;

  return { measureRef, outerStyle };
}
