import type { Terminal as XTerm } from 'xterm';
import type { OutputBuffer } from './recent-output';

/** What an action outside a pane reads from that pane's xterm. */
export type TerminalReader = Pick<XTerm, 'getSelection'> & { buffer: { active: OutputBuffer } };

/** The xterm of every mounted terminal pane, by paneId. */
const instances = new Map<string, TerminalReader>();

export function registerTerminalInstance(paneId: string, xterm: TerminalReader): void {
  instances.set(paneId, xterm);
}

export function unregisterTerminalInstance(paneId: string): void {
  instances.delete(paneId);
}

export function getTerminalInstance(paneId: string): TerminalReader | undefined {
  return instances.get(paneId);
}
