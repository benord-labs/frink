/**
 * Ghost Run trigger — a "Rehearse" control on the flow canvas. Runs the local heuristic
 * rehearsal and toggles the ghost overlay. Mounts inside `CanvasControls.children`, so it
 * lives within the React Flow provider where `ControlButton` is valid.
 */
import { ControlButton } from '@xyflow/react';
import { useAtomValue, useSetAtom } from 'jotai';
import { FlaskConical } from 'lucide-react';
import { type ReactElement, useEffect, useRef } from 'react';
import type { CustomNodeInputsByType } from '../../../../shared/lib/flows/custom-node-required-inputs';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { clearRehearsal, ghostRunActiveAtom, rehearseFlow } from '../../../lib/flow-rehearsal';
import { cn } from '../../../lib/utils';

type GhostRunButtonProps = {
  /** Current working graph (rehearsal walks this). */
  graph: FlowGraph;
  /** Scopes the ghost atoms to the active flow (same key format as live exec). */
  flowId?: string;
  /**
   * Declared inputs per installed custom node. Undefined means "manifests not known yet", which the
   * analyzer reads as unknown rather than as "nothing is required".
   */
  customNodeInputs?: CustomNodeInputsByType;
};

export function GhostRunButton({
  graph,
  flowId,
  customNodeInputs,
}: GhostRunButtonProps): ReactElement {
  const ghostActive = useAtomValue(ghostRunActiveAtom);
  const setGhostActive = useSetAtom(ghostRunActiveAtom);

  // Manifests arrive asynchronously, so a rehearsal started before they land would sit there
  // claiming the flow is healthy without ever having checked required inputs. Re-run when they
  // arrive (and whenever the graph changes) so an active overlay always reflects what is known.
  // Graph edits are debounced: config fields replace the graph on every keystroke, and an
  // immediate re-run per character would rehearse the whole flow per keypress.
  const prevGraphRef = useRef(graph);
  const wasActiveRef = useRef(false);
  useEffect(() => {
    if (!ghostActive || !flowId) {
      wasActiveRef.current = false;
      return;
    }
    const justActivated = !wasActiveRef.current;
    wasActiveRef.current = true;
    const graphEdited = !justActivated && prevGraphRef.current !== graph;
    prevGraphRef.current = graph;
    if (!graphEdited) {
      void rehearseFlow(flowId, graph, customNodeInputs);
      return;
    }
    const handle = window.setTimeout(() => {
      void rehearseFlow(flowId, graph, customNodeInputs);
    }, 300);
    return () => window.clearTimeout(handle);
  }, [ghostActive, flowId, graph, customNodeInputs]);

  const handleToggle = (): void => {
    if (!flowId) return;
    if (ghostActive) {
      clearRehearsal(flowId, graph);
      setGhostActive(false);
      return;
    }
    // The effect above owns running the rehearsal, for both this activation and any later
    // manifest arrival, so there is exactly one path that writes the ghost atoms.
    setGhostActive(true);
  };

  return (
    <ControlButton
      onClick={handleToggle}
      disabled={!flowId || graph.nodes.length === 0}
      title={ghostActive ? 'Stop rehearsal (Esc)' : 'Rehearse flow — predict this run'}
      aria-label={ghostActive ? 'Stop rehearsal' : 'Rehearse flow'}
      aria-pressed={ghostActive}
      className={cn(ghostActive && 'bg-primary/15! text-primary!')}
    >
      <FlaskConical className="h-3.5 w-3.5" aria-hidden />
    </ControlButton>
  );
}
