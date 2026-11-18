import { z } from 'zod';
import {
  type FlowGraphInput,
  flowDetailsSchema,
  flowGraphSchema,
} from '../../../types/flow-graph-schema';
import { getBlockRegistration } from '../../block-registry';

/** Upper bound on a flow file; a 50-step flow is a few hundred KB at most. */
export const MAX_FLOW_FILE_BYTES = 1024 * 1024;

const FLOW_FILE_KIND = 'frink-flow';
const FLOW_FILE_VERSION = 1;
const PROJECT_KEYS = ['projectId', 'bindingProjectId'] as const;
const ACCOUNT_KEYS = ['integrationId', 'connectionId'] as const;
const NOT_A_FLOW = "This file isn't a Frink flow.";

const stepRef = z.string().min(1).optional().catch(undefined);
/** The config keys that point at this computer's projects and connected accounts. */
const stepRefsSchema = z.object({
  projectId: stepRef,
  bindingProjectId: stepRef,
  integrationId: stepRef,
  connectionId: stepRef,
});

const flowFileSchema = flowDetailsSchema.partial({ description: true }).extend({
  kind: z.literal(FLOW_FILE_KIND),
  version: z.literal(FLOW_FILE_VERSION),
  graph: flowGraphSchema,
  /** Project id → name on the exporting computer, so the importing one can match by name. */
  projects: z.record(z.string(), z.string()).default({}),
});

export type FlowFile = z.infer<typeof flowFileSchema>;
type LocalProject = { id: string; name: string };
type FlowFileNode = FlowGraphInput['nodes'][number];
type ProjectMatch = { missing: boolean; value: string };

export type LocalizedFlow = {
  graph: FlowGraphInput;
  /** The flow's own project: the default project when it exists on this computer. */
  projectId: string | null;
  /** Steps to finish setting up before the flow can run here. */
  needsSetup: string[];
};

/** The file text for a saved flow, with the names of the projects its steps use. */
export function serializeFlowFile(
  flow: { name: string; description: string | null; graph: unknown },
  localProjects: readonly LocalProject[],
): string {
  const graph = flowGraphSchema.parse(flow.graph);
  const used = new Set([graph.settings?.defaultProjectId, ...graph.nodes.flatMap(nodeProjectIds)]);
  const projects = Object.fromEntries(
    localProjects.filter((project) => used.has(project.id)).map((p) => [p.id, p.name]),
  );
  const file: FlowFile = {
    kind: FLOW_FILE_KIND,
    version: FLOW_FILE_VERSION,
    name: flow.name,
    description: flow.description,
    graph,
    projects,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

function nodeProjectIds(node: FlowFileNode): Array<string | undefined> {
  const refs = stepRefsSchema.parse(node.config ?? {});
  return PROJECT_KEYS.map((key) => refs[key]);
}

/** Reads a flow file, or says in plain words why it can't be used. */
export function parseFlowFile(
  text: string,
): { ok: true; file: FlowFile } | { ok: false; message: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return { ok: false, message: NOT_A_FLOW };
  }
  const header = z.object({ kind: z.literal(FLOW_FILE_KIND), version: z.number() }).safeParse(raw);
  if (!header.success) return { ok: false, message: NOT_A_FLOW };
  if (header.data.version > FLOW_FILE_VERSION) {
    return {
      ok: false,
      message: 'This flow was made by a newer version of Frink. Update Frink to import it.',
    };
  }
  const parsed = flowFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: 'This flow file is damaged or incomplete.' };
  return { ok: true, file: parsed.data };
}

/** Points a flow file at this computer's projects and accounts. A missing project is dropped as the
 * default but kept by name on a step, which then stops instead of running in the default project. */
export function localizeFlowGraph(
  file: FlowFile,
  local: { projects: readonly LocalProject[]; accountIds: ReadonlySet<string> },
): LocalizedFlow {
  const graph = structuredClone(file.graph);
  const localIds = new Set(local.projects.map((project) => project.id));
  const needsSetup = new Set<string>();
  const settings = graph.settings;
  if (settings?.defaultProjectId) {
    const match = matchProject(settings.defaultProjectId, file.projects, local.projects);
    if (match.missing) delete settings.defaultProjectId;
    else settings.defaultProjectId = match.value;
  }
  for (const node of graph.nodes) {
    if (localizeNodeConfig(node, file.projects, local) || node.blockType === 'post_task_trigger') {
      needsSetup.add(nodeLabel(node));
    }
  }
  const defaultId = settings?.defaultProjectId;
  return {
    graph,
    projectId: defaultId && localIds.has(defaultId) ? defaultId : null,
    needsSetup: [...needsSetup],
  };
}

/** Rewrites one step's project and account references; true when a project is still missing. */
function localizeNodeConfig(
  node: FlowFileNode,
  fileProjects: FlowFile['projects'],
  local: { projects: readonly LocalProject[]; accountIds: ReadonlySet<string> },
): boolean {
  const config = node.config;
  if (!config) return false;
  const refs = stepRefsSchema.parse(config);
  let missingProject = false;
  for (const key of ACCOUNT_KEYS) {
    const value = refs[key];
    if (value !== undefined && !local.accountIds.has(value)) delete config[key];
  }
  for (const key of PROJECT_KEYS) {
    const value = refs[key];
    if (value === undefined) continue;
    const match = matchProject(value, fileProjects, local.projects);
    if (!match.missing || key === 'projectId') config[key] = match.value;
    else delete config[key];
    missingProject ||= match.missing;
  }
  return missingProject;
}

/** Maps an exporting computer's project id to the one project here with the same name. A local id,
 * a name or a template is kept as written; a missing project yields its name. */
function matchProject(
  value: string,
  fileProjects: FlowFile['projects'],
  localProjects: readonly LocalProject[],
): ProjectMatch {
  const name = Object.hasOwn(fileProjects, value) ? fileProjects[value] : undefined;
  if (name === undefined || localProjects.some((project) => project.id === value)) {
    return { missing: false, value };
  }
  const named = localProjects.filter((project) => project.name === name);
  return named.length === 1
    ? { missing: false, value: named[0].id }
    : { missing: true, value: name };
}

function nodeLabel(node: FlowFileNode): string {
  return node.label?.trim() || getBlockRegistration(node.blockType)?.label || node.blockType;
}
