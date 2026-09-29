import { beforeEach, describe, expect, it } from 'vitest';
import { createProject } from '../../db/repos/projects';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import type { FlowGraphNode, ParsedFlowGraph } from '../graph';
import { resolveDispatchProjectId, resolveNodeOrFlowProjectId } from './project-id';

// Runtime twin of the renderer's getEffectiveNodeProjectId: a node's own projectId
// wins, otherwise the flow's default project is used. Both inputs come from
// unchecked graph JSON, so every non-string shape must degrade to "no project"
// rather than crash a flow run mid-dispatch.
describe('resolveNodeOrFlowProjectId', () => {
  it('prefers the node projectId over a differing flow default', () => {
    expect(
      resolveNodeOrFlowProjectId({ projectId: 'node-pid' }, { defaultProjectId: 'flow-pid' }, {}),
    ).toBe('node-pid');
  });

  it('falls back to the flow default when the node has no projectId', () => {
    expect(
      resolveNodeOrFlowProjectId({ startMode: 'plan' }, { defaultProjectId: 'flow-pid' }, {}),
    ).toBe('flow-pid');
    // A freshly-added node can have no config object at all (graph stores it as null).
    expect(resolveNodeOrFlowProjectId(undefined, { defaultProjectId: 'flow-pid' }, {})).toBe(
      'flow-pid',
    );
  });

  it('treats a whitespace-only node projectId as absent and uses the flow default', () => {
    expect(
      resolveNodeOrFlowProjectId({ projectId: '   ' }, { defaultProjectId: 'flow-pid' }, {}),
    ).toBe('flow-pid');
  });

  it('returns undefined when neither the node nor the flow names a project', () => {
    expect(resolveNodeOrFlowProjectId({}, {}, {})).toBeUndefined();
    expect(resolveNodeOrFlowProjectId(undefined, undefined, {})).toBeUndefined();
  });

  it('ignores a non-string or whitespace flow default', () => {
    expect(resolveNodeOrFlowProjectId({}, { defaultProjectId: 12345 }, {})).toBeUndefined();
    expect(resolveNodeOrFlowProjectId({}, { defaultProjectId: '   ' }, {})).toBeUndefined();
  });

  it('ignores a non-string node projectId and uses the flow default', () => {
    expect(
      resolveNodeOrFlowProjectId({ projectId: 99 }, { defaultProjectId: 'flow-pid' }, {}),
    ).toBe('flow-pid');
  });

  it('is safe when settings are absent', () => {
    expect(resolveNodeOrFlowProjectId({ projectId: 'node-pid' }, undefined, {})).toBe('node-pid');
    expect(resolveNodeOrFlowProjectId({}, undefined, {})).toBeUndefined();
  });

  it('trims surrounding whitespace from whichever projectId it returns', () => {
    expect(resolveNodeOrFlowProjectId({ projectId: '  node-pid  ' }, undefined, {})).toBe(
      'node-pid',
    );
    expect(resolveNodeOrFlowProjectId({}, { defaultProjectId: '  flow-pid  ' }, {})).toBe(
      'flow-pid',
    );
  });

  it('renders the node projectId so an upstream node can choose the target project', () => {
    expect(
      resolveNodeOrFlowProjectId({ projectId: '{{trigger.project}}' }, undefined, {
        trigger: { project: 'devkit' },
      }),
    ).toBe('devkit');
  });

  it('errors instead of inheriting the flow default when the template resolves to nothing', () => {
    // The whole point of the fail-closed rule: inheriting here would provision a worktree and
    // run an agent in the flow's default repo while reporting success.
    expect(
      resolveNodeOrFlowProjectId(
        { projectId: '{{trigger.project}}' },
        { defaultProjectId: 'flow-pid' },
        {
          trigger: { project: '' },
        },
      ),
    ).toEqual({ error: 'projectId template "{{trigger.project}}" resolved to nothing' });
  });

  it('fails closed on an unresolvable path instead of matching the placeholder as a name', () => {
    // renderTemplate leaves the placeholder literal; treating it as a routing key would let a
    // project actually named "{{trigger.nope}}" win.
    expect(resolveNodeOrFlowProjectId({ projectId: '{{trigger.nope}}' }, undefined, {})).toEqual({
      error: 'projectId template "{{trigger.nope}}" did not resolve',
    });
  });

  it('fails closed on an unresolvable path written with inner spaces', () => {
    // The path is canonicalised before lookup, so comparing rendered output to the authored
    // placeholder would wrongly call this resolved.
    expect(
      resolveNodeOrFlowProjectId({ projectId: '{{ trigger.missing }}' }, undefined, {}),
    ).toEqual({ error: 'projectId template "{{ trigger.missing }}" did not resolve' });
  });

  it('accepts a value that resolves to exactly its own placeholder text', () => {
    expect(
      resolveNodeOrFlowProjectId({ projectId: '{{trigger.project}}' }, undefined, {
        trigger: { project: '{{trigger.project}}' },
      }),
    ).toBe('{{trigger.project}}');
  });

  it('rejects a projectId long enough for rendering to clamp it', () => {
    // renderTemplate caps templates at 10k; without an input bound, an over-long value passes the
    // unresolved-path check on its full text and is then truncated into a different routing key.
    const overlong = 'a'.repeat(10_000) + '{{trigger.project}}';
    expect(
      resolveNodeOrFlowProjectId({ projectId: overlong }, undefined, {
        trigger: { project: 'devkit' },
      }),
    ).toEqual({ error: `projectId "${overlong.slice(0, 40)}…" is too long to resolve` });
  });

  it('rejects nested braces that would render into a brace-wrapped name', () => {
    expect(
      resolveNodeOrFlowProjectId({ projectId: '{{{trigger.project}}}' }, undefined, {
        trigger: { project: 'devkit' },
      }),
    ).toEqual({ error: 'projectId template "{{{trigger.project}}}" is malformed' });
  });

  it('rejects a mistyped template rather than routing it as a literal name', () => {
    expect(resolveNodeOrFlowProjectId({ projectId: '{{trigger.project' }, undefined, {})).toEqual({
      error: 'projectId template "{{trigger.project" is malformed',
    });
  });

  it('accepts a fully resolved value that itself contains braces', () => {
    // The check asks whether the INPUT's placeholders resolved, so braces arriving in the DATA are
    // just characters in a project name.
    expect(
      resolveNodeOrFlowProjectId({ projectId: '{{trigger.project}}' }, undefined, {
        trigger: { project: 'repo {{archive}}' },
      }),
    ).toBe('repo {{archive}}');
  });

  it('does not re-render its own output, so a payload cannot smuggle in a second placeholder', () => {
    expect(
      resolveNodeOrFlowProjectId({ projectId: '{{trigger.a}}' }, undefined, {
        trigger: { a: '{{trigger.b}}', b: 'devkit' },
      }),
    ).toBe('{{trigger.b}}');
  });

  it('fails closed when the template resolves to whitespace only', () => {
    // A padded webhook field is indistinguishable from an empty one once trimmed, so it must
    // take the fail-closed path rather than quietly inheriting the flow default.
    expect(
      resolveNodeOrFlowProjectId(
        { projectId: '{{trigger.project}}' },
        { defaultProjectId: 'flow-pid' },
        {
          trigger: { project: '   ' },
        },
      ),
    ).toEqual({ error: 'projectId template "{{trigger.project}}" resolved to nothing' });
  });

  it('trims padding around a resolved value so a padded payload still routes', () => {
    expect(
      resolveNodeOrFlowProjectId({ projectId: '{{trigger.project}}' }, undefined, {
        trigger: { project: '  devkit  ' },
      }),
    ).toBe('devkit');
  });

  it('renders a loop variable so a fan_out can route each item to its own project', () => {
    expect(
      resolveNodeOrFlowProjectId({ projectId: '{{loop.currentItem.repo}}' }, undefined, {
        loop: { currentItem: { repo: 'devkit' } },
      }),
    ).toBe('devkit');
  });

  it('still uses the flow default when the node field is genuinely blank', () => {
    expect(
      resolveNodeOrFlowProjectId(
        {},
        { defaultProjectId: 'flow-pid' },
        {
          trigger: { project: 'devkit' },
        },
      ),
    ).toBe('flow-pid');
  });
});

describe('resolveDispatchProjectId', () => {
  let db: TestDb;

  type NodeConfig = FlowGraphNode['config'];
  type GraphSettings = ParsedFlowGraph['settings'];

  // SAFETY: the resolver reads only node.config and parsedGraph.settings, both supplied here.
  const ctx = (config: NodeConfig, settings?: GraphSettings) =>
    ({
      node: { id: 'n', blockType: 'start_task', config },
      parsedGraph: { nodes: [], edges: [], settings },
    }) as never;

  const failure = (message: string) => ({ ok: false, failure: { type: 'error', message } });

  beforeEach(() => {
    db = freshDb();
  });

  it('resolves an exact project name to its id — a trigger payload names a repo, not a cuid2', async () => {
    const devkit = await createProject(db, { name: 'devkit', path: '/repos/devkit' });
    await createProject(db, { name: 'frink', path: '/repos/frink' });
    await expect(
      resolveDispatchProjectId(
        db,
        ctx({ projectId: '{{trigger.project}}' }),
        { trigger: { project: 'devkit' } },
        'start_task',
      ),
    ).resolves.toEqual({ ok: true, projectId: devkit.id });
  });

  it('passes a literal project id through', async () => {
    const project = await createProject(db, { name: 'frink', path: '/repos/frink' });
    await expect(
      resolveDispatchProjectId(db, ctx({ projectId: project.id }), {}, 'start_task'),
    ).resolves.toEqual({ ok: true, projectId: project.id });
  });

  it('prefers an id match over another project whose name is that same string', async () => {
    const target = await createProject(db, { name: 'frink', path: '/repos/frink' });
    await createProject(db, { name: target.id, path: '/repos/confusing' });
    await expect(
      resolveDispatchProjectId(db, ctx({ projectId: target.id }), {}, 'start_task'),
    ).resolves.toEqual({ ok: true, projectId: target.id });
  });

  it('errors quoting the value when nothing matches', async () => {
    await createProject(db, { name: 'frink', path: '/repos/frink' });
    const res = await resolveDispatchProjectId(db, ctx({ projectId: 'devkitt' }), {}, 'start_task');
    expect(res).toEqual(failure('start_task no registered project with id or name "devkitt"'));
  });

  it('errors naming both paths when two projects share a name — never silently picks one', async () => {
    await createProject(db, { name: 'devkit', path: '/repos/devkit' });
    await createProject(db, { name: 'devkit', path: '/other/devkit' });
    const res = await resolveDispatchProjectId(db, ctx({ projectId: 'devkit' }), {}, 'start_task');
    expect(res).toEqual(
      failure(
        'start_task project name "devkit" is ambiguous (/repos/devkit, /other/devkit) — use the project id',
      ),
    );
  });

  it('keeps the missing-project message when neither the node nor the flow names a project', async () => {
    const res = await resolveDispatchProjectId(db, ctx({}), {}, 'start_task');
    expect(res).toEqual(
      failure(
        'start_task missing projectId (set on the node or as the flow default project in flow settings)',
      ),
    );
  });

  it('surfaces the fail-closed template error rather than falling back to the flow default', async () => {
    const fallback = await createProject(db, { name: 'frink', path: '/repos/frink' });
    const res = await resolveDispatchProjectId(
      db,
      ctx({ projectId: '{{previous.project}}' }, { defaultProjectId: fallback.id }),
      { previous: { project: '' } },
      'start_task',
    );
    expect(res).toEqual(
      failure('start_task projectId template "{{previous.project}}" resolved to nothing'),
    );
  });

  it('fails loudly when the template resolves to an object rather than a project key', async () => {
    await createProject(db, { name: 'devkit', path: '/repos/devkit' });
    const res = await resolveDispatchProjectId(
      db,
      ctx({ projectId: '{{previous.project}}' }),
      { previous: { project: { name: 'devkit' } } },
      'start_task',
    );
    expect(res).toEqual(
      failure('start_task no registered project with id or name "{"name":"devkit"}"'),
    );
  });

  it('matches a project name case-sensitively', async () => {
    await createProject(db, { name: 'devkit', path: '/repos/devkit' });
    const res = await resolveDispatchProjectId(db, ctx({ projectId: 'Devkit' }), {}, 'start_task');
    expect(res).toEqual(failure('start_task no registered project with id or name "Devkit"'));
  });

  it('rejects a flow default that names no registered project', async () => {
    const res = await resolveDispatchProjectId(
      db,
      ctx({}, { defaultProjectId: 'stale-pid' }),
      {},
      'start_task',
    );
    expect(res).toEqual(failure('start_task no registered project with id or name "stale-pid"'));
  });

  it('errors rather than throwing when no projects are registered at all', async () => {
    const res = await resolveDispatchProjectId(db, ctx({ projectId: 'devkit' }), {}, 'start_task');
    expect(res).toEqual(failure('start_task no registered project with id or name "devkit"'));
  });

  it('labels the error with the calling block so a custom node names itself', async () => {
    const res = await resolveDispatchProjectId(
      db,
      ctx({ projectId: 'devkit' }),
      {},
      'Custom node "check-new-prs"',
    );
    expect(res).toEqual(
      failure('Custom node "check-new-prs" no registered project with id or name "devkit"'),
    );
  });

  it('resolves names against an indexed column', () => {
    // projects_name_idx is declared only in migration 0092, not in the drizzle schema (see the
    // PR notes: schema/index.ts sits above its size ratchet). This assertion is the only thing
    // standing between a rename/refactor and an unindexed name scan on every node dispatch.
    // SAFETY: sqlite_master rows expose `name` as text for every index row selected here.
    const rows = db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'projects'")
      .all() as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toContain('projects_name_idx');
  });
});
