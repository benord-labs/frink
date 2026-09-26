/**
 * Shared React Flow fit-view hook used by all canvas components.
 *
 * Waits for the pane to have real dimensions (via React Flow's own store width)
 * and for nodes to be ready before running fitView once. Resets the fit trigger
 * when `resetKey` changes (topology/flow switch) or when a CSS-hidden canvas
 * becomes visible.
 */
import { useNodesInitialized, useReactFlow, useStore } from '@xyflow/react';
import { useCallback, useEffect, useRef } from 'react';

type UseCanvasFitViewOptions = {
  padding: number;
  /** Changing this key resets the fit trigger (e.g. flow switch, topology change). */
  resetKey: string;
  /** Set false when the canvas is CSS-hidden (display:none). Resets fit on visible transition. */
  isVisible?: boolean;
  /**
   * Skip waiting for React Flow's internal node measurement pass.
   * Set true when all nodes have explicit width/height (e.g. batch DAG canvases).
   * RF v12 skips measurement for non-interactive nodes (elementsSelectable=false +
   * nodesDraggable=false), so nodesInitialized never becomes true for those canvases.
   */
  skipNodesInitialized?: boolean;
};

/**
 * Returns a stable `handleFitView` callback for use in a fit-view control button.
 * Automatically fits the view once when the pane has real dimensions, nodes are
 * ready, and the canvas is visible.
 *
 * Must be called inside a ReactFlowProvider context.
 */
export function useCanvasFitView(
  nodeCount: number,
  { padding, resetKey, isVisible = true, skipNodesInitialized = false }: UseCanvasFitViewOptions,
): () => void {
  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const paneHasWidth = useStore((s) => s.width > 0);
  const didFitRef = useRef(false);

  useEffect(() => {
    didFitRef.current = false;
  }, [resetKey]);

  const prevVisibleRef = useRef(isVisible);
  useEffect(() => {
    const wasVisible = prevVisibleRef.current;
    prevVisibleRef.current = isVisible;
    if (isVisible && !wasVisible) {
      didFitRef.current = false;
    }
  }, [isVisible]);

  const nodesReady = skipNodesInitialized || nodesInitialized;

  useEffect(() => {
    // `resetKey` is in the deps below but unused in the body: it re-triggers this effect
    // after the effect above sets `didFitRef` to false (effects flush in order), so fitView
    // can run again after a flow/topology reset.
    if (paneHasWidth && nodesReady && nodeCount > 0 && !didFitRef.current && isVisible) {
      didFitRef.current = true;
      requestAnimationFrame(() => {
        fitView({ padding, duration: 200 });
      });
    }
  }, [paneHasWidth, nodesReady, nodeCount, isVisible, fitView, padding, resetKey]);

  return useCallback(() => fitView({ padding, duration: 200 }), [fitView, padding]);
}
