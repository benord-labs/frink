import { useAtom } from 'jotai';
import { useEffect, useId, useRef, useState } from 'react';
import { flowNoteDraftAtomFamily, flowNoteDraftKey } from './flow-note-draft';

/**
 * Open/closed + draft state for the running strip's note field. Extracted from FlowRunStrip so that
 * component stays inside its cognitive budget and this behaviour — which is all policy, no markup —
 * can be read (and reasoned about) on its own.
 *
 * Closed by default: notes stay deliberate (decision flow-run-chat-surface). The draft lives in an
 * atom so it survives the strip unmounting when the run parks or ends, and the field REOPENS on
 * mount when there is one, because a preserved draft the user cannot see is a silent stash — they
 * retype it, or send it stale a node later. Reopen is mount-time only, so an Escape-collapsed draft
 * stays put for this mount and is one click away rather than springing the field back open.
 */
export function useFlowNoteField(flowRunId: string, subChatId: string) {
  const draftKey = flowNoteDraftKey(flowRunId, subChatId);
  const [note, setNote] = useAtom(flowNoteDraftAtomFamily(draftKey));
  const [open, setOpen] = useState(() => note.trim().length > 0);
  const fieldId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const refocusRef = useRef(false);
  // Latest draft without making the scope effect below depend on every keystroke.
  const noteRef = useRef(note);
  noteRef.current = note;

  // Re-derive `open` when the SCOPE changes. useState's initializer runs once per mount, but the
  // strip instance is reused when the same sub-chat starts a new run — the atom underneath switches
  // while `open` keeps the previous scope's state, leaving either a field open over an empty draft
  // or, worse, the new run's draft hidden behind a collapsed toggle (the silent stash again).
  const scopeRef = useRef(draftKey);
  useEffect(() => {
    if (scopeRef.current === draftKey) return;
    scopeRef.current = draftKey;
    refocusRef.current = false; // a pending refocus belongs to the old scope
    setOpen(noteRef.current.trim().length > 0);
  }, [draftKey]);

  /**
   * `discard` separates a DELIBERATE dismissal from an involuntary one: the ✕ drops the text,
   * Escape only collapses. Focus goes back to the toggle — it would otherwise fall to <body> and
   * restart the next Tab at the top of the chat.
   *
   * Deferred to an effect, not called inline, because the toggle does not exist while the field is
   * open: it is removed rather than left sitting above its own open field as a control offering a
   * verb you have already carried out. So the focus target only comes back on the render that
   * `setOpen(false)` triggers, and there is nothing to focus until then.
   */
  const collapse = (discard: boolean) => {
    if (discard) setNote('');
    refocusRef.current = true;
    setOpen(false);
  };
  useEffect(() => {
    if (open || !refocusRef.current) return;
    refocusRef.current = false;
    toggleRef.current?.focus();
  }, [open]);

  return { note, setNote, open, expand: () => setOpen(true), collapse, fieldId, toggleRef };
}
