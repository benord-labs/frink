/** In-memory vendor APIs behind `fetch`, enough to prove idempotent registration and lifecycle ordering. */
import { expect } from 'vitest';
import { z } from 'zod';

type ClickupHook = {
  id: string;
  team_id: number;
  endpoint: string;
  events: string[];
  secret: string;
  task_id: null;
  list_id: null;
  folder_id: null;
  space_id: null;
  health: { status: string };
};

type ClickupState = {
  hooks: Map<string, ClickupHook>;
  /** Every write, in call order. */
  mutations: { method: string; id?: string; workspaceId?: string }[];
  workspaces: { id: string; name: string }[];
  loseCreate: boolean;
  loseDelete: boolean;
  deny: boolean;
  created: number;
};

function clickupWorkspaceRoute(
  state: ClickupState,
  workspaceId: string,
  method: string,
  rawBody: string,
): Response {
  if (method === 'GET')
    return Response.json({
      webhooks: [...state.hooks.values()].filter((h) => String(h.team_id) === workspaceId),
    });
  state.mutations.push({ method, workspaceId });
  state.created += 1;
  const body = JSON.parse(rawBody);
  const hook: ClickupHook = {
    id: `hook-${state.created}`,
    team_id: Number(workspaceId),
    endpoint: body.endpoint,
    events: body.events,
    secret: `secret-${state.created}`,
    task_id: null,
    list_id: null,
    folder_id: null,
    space_id: null,
    health: { status: 'active' },
  };
  state.hooks.set(hook.id, hook);
  if (state.loseCreate) {
    state.loseCreate = false;
    throw new Error('lost create');
  }
  return Response.json({ id: hook.id, webhook: hook });
}

function clickupHookRoute(
  state: ClickupState,
  id: string,
  method: string,
  rawBody: string,
): Response {
  state.mutations.push({ method, id });
  const hook = state.hooks.get(id);
  if (!hook) return new Response('', { status: 404 });
  if (method !== 'DELETE') {
    Object.assign(hook, JSON.parse(rawBody), { health: { status: 'active' } });
    return Response.json({ id, webhook: hook });
  }
  state.hooks.delete(id);
  if (state.loseDelete) {
    state.loseDelete = false;
    throw new Error('lost delete');
  }
  return Response.json({});
}

function clickupRoute(
  state: ClickupState,
  path: string,
  method: string,
  rawBody: string,
): Response {
  if (path === '/api/v2/team') return Response.json({ teams: state.workspaces });
  if (path.includes('/team/'))
    return clickupWorkspaceRoute(state, path.split('/')[4], method, rawBody);
  return clickupHookRoute(state, path.split('/').at(-1) ?? '', method, rawBody);
}

/** ClickUp REST subscriptions: one workspace, webhooks keyed by the destination they post to. */
export function fakeClickupApi(token = 'pk_private') {
  const state: ClickupState = {
    hooks: new Map(),
    mutations: [],
    workspaces: [{ id: '1', name: 'Workspace' }],
    loseCreate: false,
    loseDelete: false,
    deny: false,
    created: 0,
  };
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    expect(new Headers(init?.headers).get('Authorization')).toBe(token);
    if (state.deny) return new Response('the key should never escape', { status: 403 });
    const url = new URL(String(input));
    return clickupRoute(state, url.pathname, init?.method ?? 'GET', String(init?.body));
  };
  return { fetch, hooks: state.hooks, mutations: state.mutations, state };
}

type FakeHogFunction = { name: string; url: string; deleted: boolean };
type PosthogState = { functions: Map<string, FakeHogFunction>; created: number };

const posthogPatch = z.object({
  deleted: z.boolean().optional(),
  inputs: z.object({ url: z.object({ value: z.string() }) }).optional(),
});
const posthogCreate = z.object({
  name: z.string(),
  inputs: z.object({ url: z.object({ value: z.string() }) }),
});
const HOG_FUNCTION_PATH = /\/hog_functions\/([^/]+)\/$/;

function posthogFunctionRoute(
  state: PosthogState,
  fnId: string,
  method: string,
  rawBody: string,
): Response {
  const fn = state.functions.get(fnId);
  if (!fn || fn.deleted) return new Response('missing', { status: 404 });
  if (method === 'PATCH') {
    const { deleted, inputs } = posthogPatch.parse(JSON.parse(rawBody));
    state.functions.set(fnId, {
      ...fn,
      url: inputs?.url.value ?? fn.url,
      deleted: deleted === true,
    });
  }
  return Response.json({ id: fnId, inputs: { url: { value: fn.url } } });
}

function posthogCollectionRoute(state: PosthogState, method: string, rawBody: string): Response {
  if (method === 'POST') {
    state.created += 1;
    const body = posthogCreate.parse(JSON.parse(rawBody));
    const id = `fn_${state.created}`;
    state.functions.set(id, { name: body.name, url: body.inputs.url.value, deleted: false });
    return Response.json({ id });
  }
  const results = [...state.functions.entries()]
    .filter(([, fn]) => !fn.deleted)
    .map(([id, fn]) => ({ id, name: fn.name }));
  return Response.json({ results, next: null });
}

/** The token is valid in one region only. */
function posthogAuthorized(
  target: URL,
  init: RequestInit | undefined,
  region: string,
  token: string,
) {
  return (
    target.hostname === `${region}.posthog.com` &&
    new Headers(init?.headers).get('authorization') === `Bearer ${token}`
  );
}

/** Destinations are hog functions the list endpoint returns without inputs. */
export function fakePosthogApi(region: 'us' | 'eu', token = 'pha_mcp_token') {
  const state: PosthogState = { functions: new Map(), created: 0 };
  /** `METHOD /path` in call order. */
  const requests: string[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = new URL(String(url));
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${target.pathname}`);
    if (!posthogAuthorized(target, init, region, token)) {
      return new Response('unauthorized', { status: 401 });
    }
    if (target.pathname === '/api/users/@me/') return Response.json({ team: { id: 42 } });
    const rawBody = String(init?.body);
    const [, fnId] = HOG_FUNCTION_PATH.exec(target.pathname) ?? [];
    if (fnId) return posthogFunctionRoute(state, fnId, method, rawBody);
    return posthogCollectionRoute(state, method, rawBody);
  };
  return { fetch, functions: state.functions, requests };
}
