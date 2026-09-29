/**
 * Runtime projectId resolution for flow dispatchers: the node's own projectId — rendered as a
 * Flow template, so `{{trigger.project}}` can route a run to a project decided upstream — else
 * the flow's settings.defaultProjectId, else undefined. The runtime analog of the renderer's
 * getEffectiveNodeProjectId. `settings` is `Record<string, unknown>`, so the type is guarded.
 *
 * FAILS CLOSED: an author-set projectId that renders to nothing is an error, never a
 * fall-through to the flow default. Falling through provisions a worktree and runs an agent in
 * a different repo than the flow asked for while reporting success — the exact silent
 * mis-dispatch this resolution exists to prevent. The flow default applies ONLY when the author
 * left the node field blank.
 */

import { z } from 'zod';
import { findProjectsByIdOrName } from '../../db/repos/projects';
import type { ParsedFlowGraph } from '../graph';
import { hasUnresolvedPlaceholder, renderTemplate } from '../template-utils';
import type { DispatchContext } from './types';

type TemplateContext = Parameters<typeof renderTemplate>[1];

/** A node projectId worth using: a string with something in it once trimmed. */
/**
 * A node projectId worth using: non-empty once trimmed, and short enough that renderTemplate
 * cannot clamp it. Without the cap an over-long template passes the unresolved-path check on its
 * full text and is then TRUNCATED during rendering, which can yield a different — but valid —
 * routing key instead of failing closed. A project id or name is never near this long.
 */
const MAX_PROJECT_KEY_LENGTH = 512;
/** Shared with other dispatchers needing "a string with something in it once trimmed". */
export const NON_EMPTY_TEXT = z
  .string()
  .transform((v) => v.trim())
  .pipe(z.string().min(1));

export function resolveNodeOrFlowProjectId(
  config: Record<string, unknown> | undefined,
  settings: ParsedFlowGraph['settings'],
  variables: TemplateContext,
): string | { error: string } | undefined {
  const nodePid = NON_EMPTY_TEXT.safeParse(config?.projectId);
  if (nodePid.success) {
    const raw = nodePid.data;
    // Length is an error, not a fall-through: treating an over-long value as "unset" would inherit
    // the flow default, the silent mis-dispatch this resolver exists to prevent.
    if (raw.length > MAX_PROJECT_KEY_LENGTH) {
      return { error: `projectId "${raw.slice(0, 40)}…" is too long to resolve` };
    }
    // Fail closed on an unresolved path: renderTemplate would hand back its literal placeholder,
    // which would then be matched against project names and could select one literally so named.
    if (hasUnresolvedPlaceholder(raw, variables)) {
      return { error: `projectId template "${raw}" did not resolve` };
    }
    // Any brace left after removing well-formed placeholders is a mistyped template, not a name;
    // routing it literally could select a project bearing that text. The editor treats any `{{`
    // as template-shaped too, so this keeps authoring and dispatch on the same rule.
    if (/[{}]/.test(raw.replace(/\{\{[^{}]+\}\}/g, ''))) {
      return { error: `projectId template "${raw}" is malformed` };
    }
    const rendered = renderTemplate(raw, variables).trim();
    if (!rendered) return { error: `projectId template "${raw}" resolved to nothing` };
    return rendered;
  }
  const defPid = settings?.defaultProjectId;
  return typeof defPid === 'string' ? defPid.trim() || undefined : undefined;
}

/** Node projectId, else the flow default. No template rendering and no existence check. */
export function resolveStaticProjectId(
  config: Parameters<typeof resolveNodeOrFlowProjectId>[0],
  settings: ParsedFlowGraph['settings'],
): string | undefined {
  const nodePid = NON_EMPTY_TEXT.safeParse(config?.projectId);
  if (nodePid.success) return nodePid.data;
  const defPid = NON_EMPTY_TEXT.safeParse(settings?.defaultProjectId);
  return defPid.success ? defPid.data : undefined;
}

/** The above, then id-or-name to a real project id, or an error the caller returns verbatim. */
type DispatchError = { type: 'error'; message: string };

export async function resolveDispatchProjectId(
  db: Parameters<typeof findProjectsByIdOrName>[0],
  ctx: Pick<DispatchContext, 'node' | 'parsedGraph'>,
  variables: TemplateContext,
  blockLabel: string,
): Promise<{ ok: true; projectId: string } | { ok: false; failure: DispatchError }> {
  const resolved = resolveNodeOrFlowProjectId(ctx.node.config, ctx.parsedGraph.settings, variables);
  if (resolved === undefined) {
    return fail(
      `${blockLabel} missing projectId (set on the node or as the flow default project in flow settings)`,
    );
  }
  if (resolved instanceof Object) return fail(`${blockLabel} ${resolved.error}`);

  const candidates = await findProjectsByIdOrName(db, resolved);
  // Id first: a literal id can never be shadowed by someone naming another project after it.
  const byId = candidates.find((p) => p.id === resolved);
  if (byId) return { ok: true, projectId: byId.id };
  // A trigger payload names a project the way a human does ("devkit"), never as a cuid2, so an
  // exact name resolves too. Names are not unique (only `path` is), and silently picking one
  // would route the same flow to a different checkout as rows are touched.
  const byName = candidates.filter((p) => p.name === resolved);
  if (byName.length === 1) return { ok: true, projectId: byName[0].id };
  if (byName.length > 1) {
    const paths = byName.map((p) => p.path).join(', ');
    return fail(
      `${blockLabel} project name "${resolved}" is ambiguous (${paths}) — use the project id`,
    );
  }
  return fail(`${blockLabel} no registered project with id or name "${resolved}"`);
}

type ResolveFailure = { ok: false; failure: DispatchError };

const fail = (message: string): ResolveFailure => ({
  ok: false,
  failure: { type: 'error', message },
});
