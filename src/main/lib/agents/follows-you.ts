/** The coding tools Frink bridges user skills between. */
export type SkillTool = 'claude-code' | 'cursor';

/**
 * The tools Frink carries config to. Independent of which provider Frink RUNS — Cursor is a bridge
 * target whether or not it executes anything, so this is a fixed set, not a credential lookup.
 */
export const BRIDGED_TOOLS: SkillTool[] = ['claude-code', 'cursor'];

/**
 * Per-tool skill READ dirs — source-verified (the read-map note under `provider-config-canonical-home`).
 * Claude Code reads ONLY `.claude/skills`; Cursor reads `.cursor` + `.agents` + `.claude` (compat). A skill
 * "follows you" when it sits in ≥1 dir that EACH of your tools reads — NOT by being in `.agents` alone
 * (Claude never reads `.agents`).
 */
const SKILL_READ_DIRS: Record<SkillTool, readonly string[]> = {
  'claude-code': ['.claude'],
  cursor: ['.cursor', '.agents', '.claude'],
};

/**
 * Per-tool AGENT read dirs — DIFFERENT from skills. Agents have NO shared `.agents`, and Cursor does NOT
 * read `.claude/agents` (each tool reads only its own native dir; `.frink` is Frink's claude-flavour mirror
 * Claude also reads). So a `.claude`-only agent is readable by Claude but NOT Cursor — whereas a `.claude`
 * skill IS readable by Cursor (compat). Using the skill map for agents would falsely mark a `.claude`-only
 * agent "Synced" and hide the "Copy across…" affordance.
 */
const AGENT_READ_DIRS: Record<SkillTool, readonly string[]> = {
  'claude-code': ['.claude', '.frink'],
  cursor: ['.cursor'],
};

/** Which read-map a resource uses (agents and skills differ — see the two consts above). */
export type ReadKind = 'skill' | 'agent';
const readDirsFor = (kind: ReadKind): Record<SkillTool, readonly string[]> =>
  kind === 'agent' ? AGENT_READ_DIRS : SKILL_READ_DIRS;

/** Where each tool natively owns/writes its skills (its primary dir). */
const TOOL_NATIVE_DIR: Record<SkillTool, string> = {
  'claude-code': '.claude',
  cursor: '.cursor',
};

/** The universal home Codex/Gemini/opencode + Cursor read; Claude never does. */
const UNIVERSAL_SKILL_DIR = '.agents';

/**
 * The tool dirs a USER-initiated "copy across" should write, by breadth (returns bare dir names like
 * '.claude'; the caller joins `<base>/<dir>/skills`):
 * - 'portable': `.agents` + the native dir of every configured tool that can't read `.agents` (only
 *   Claude) — the minimal set that makes the skill readable by EVERY configured tool ("Synced"). Never
 *   writes a non-configured tool's dir.
 * - 'native': just `activeTool`'s own native dir (the one-tool quick copy).
 */
export function skillCopyDirs(
  mode: 'portable' | 'native',
  configuredTools: SkillTool[],
  activeTool?: SkillTool,
): string[] {
  if (mode === 'native') return activeTool ? [TOOL_NATIVE_DIR[activeTool]] : [];
  const dirs = new Set<string>([UNIVERSAL_SKILL_DIR]);
  for (const t of configuredTools) {
    if (!SKILL_READ_DIRS[t].includes(UNIVERSAL_SKILL_DIR)) dirs.add(TOOL_NATIVE_DIR[t]);
  }
  return [...dirs];
}

/** Where each tool natively owns/reads its AGENTS. Unlike skills there is NO shared `.agents` for agents
 * (deliverAgentBrain fans only to .claude/.cursor/.frink agents dirs), so each tool needs its own dir. */
const AGENT_NATIVE_DIR: Record<SkillTool, string> = {
  'claude-code': '.claude',
  cursor: '.cursor',
};

/**
 * The tool dirs (bare names; the caller joins `<base>/<dir>/agents`) a USER-initiated agent copy should
 * write, by breadth:
 * - 'portable': the native agents dir of EVERY configured tool — there is NO universal `.agents` for
 *   agents, so portable = one dir per configured tool (Claude reads .claude/agents, Cursor .cursor/agents).
 * - 'native': just `activeTool`'s own agents dir.
 * Deliberately NOT skillCopyDirs: the SKILLS read-map lets Cursor read `.agents`, which is false for agents.
 */
export function agentCopyDirs(
  mode: 'portable' | 'native',
  configuredTools: SkillTool[],
  activeTool?: SkillTool,
): string[] {
  if (mode === 'native') return activeTool ? [AGENT_NATIVE_DIR[activeTool]] : [];
  return [...new Set(configuredTools.map((t) => AGENT_NATIVE_DIR[t]))];
}

/** Whether `filePath` sits in any dir `tool` reads (per the verified read-map for `kind`). */
export function readableByTool(
  filePath: string,
  tool: SkillTool,
  kind: ReadKind = 'skill',
): boolean {
  return readDirsFor(kind)[tool].some(
    (d) => filePath.includes(`/${d}/`) || filePath.includes(`\\${d}\\`),
  );
}

/** Whether `tool` is one Frink maps skill read-dirs for (claude-code/cursor). Detector fail-safe. */
export function isMappedTool(tool: string): tool is SkillTool {
  return tool === 'claude-code' || tool === 'cursor';
}

/** The subset of `userTools` that can READ this resource (across all its copies' paths). */
export function readableBy(
  paths: string[],
  userTools: SkillTool[],
  kind: ReadKind = 'skill',
): SkillTool[] {
  return userTools.filter((tool) => paths.some((p) => readableByTool(p, tool, kind)));
}

/** Follows you = every configured tool can read at least one copy (else it's a gap). */
export function followsYouAcross(
  paths: string[],
  userTools: SkillTool[],
  kind: ReadKind = 'skill',
): boolean {
  return userTools.length > 0 && readableBy(paths, userTools, kind).length === userTools.length;
}
