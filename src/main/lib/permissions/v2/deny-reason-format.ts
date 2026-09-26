/**
 * Renders a `DenyReason` from the v2 dispatcher into a one-line user-facing
 * message. Used by `socket/executor.ts` to surface a structured deny reason in
 * agent transcripts.
 *
 * Pure function. Exhaustive `kind` switch — TypeScript catches a missed case
 * via the `never`-typed default branch.
 *
 * Ticket 09 of the permissions overhaul.
 */

import type { DenyReason } from './types';

export function formatDenyReason(reason: DenyReason): string {
  switch (reason.kind) {
    case 'rule:deny':
      return `Denied by ${reason.tier}-tier rule ${reason.rule}`;
    case 'safety:path':
      return `Path is denied by safety policy: ${reason.path}`;
    case 'db:unavailable':
      return 'Permission database is unavailable; cannot evaluate request';
    default: {
      const exhaustive: never = reason;
      void exhaustive;
      return 'Permission denied';
    }
  }
}
