import { randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { setGlobalMcpServer } from '../../../mcp/config';
import {
  CANARY_GAPS,
  CANARY_ROWS,
  type CanaryProvider,
  type CanaryRow,
  type CanaryRowId,
} from './baseline';

// No row for commands (a /command is expanded into the prompt before the turn), plugins (only
// catalogue-pinned vendor plugins are staged) or the sub-agent tool limit (enforced, never sent).

const hex = randomBytes(2).toString('hex');
const mark = (name: string) => `frink_canary_${name}_${hex}`;

/** One marker per row. The hook and the MCP server build theirs when they run: no file holds it. */
const MARKS = {
  // Claude reads the project's AGENTS.md itself and gets it again in Frink's prompt: either passes.
  'instructions (project)': mark('project'),
  instructions: mark('instructions'),
  skills: mark('skills'),
  // Claude gets agents twice, as the SDK `agents` option and the linked folder: either passes.
  agentBrain: mark('agents'),
  memory: mark('memory'),
  hooks: mark('hooks'),
  mcp: mark('mcp'),
} satisfies Record<CanaryRow, string>;

/** Newline-delimited JSON-RPC: `initialize`, one tool in `tools/list`, and `{}` for the rest. */
const MCP_SERVER = `import readline from 'node:readline';
const name = ['frink', 'canary', 'mcp', process.argv[2]].join('_');
const tool = { name, inputSchema: { type: 'object' } };
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  const info = { name: 'frink-canary', version: '1.0.0' };
  const result = method === 'initialize'
    ? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: info }
    : method === 'tools/list' ? { tools: [tool] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
});
`;

const Settings = z.looseObject({ hooks: z.record(z.string(), z.array(z.json())).default({}) });

async function write(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

const described = (name: string, marker: string) =>
  `---\nname: frink-canary\ndescription: ${name} ${marker}\n---\nSay done.\n`;

/** Adds a prompt hook that prints the hooks marker; every key already in the file is kept. */
async function mergeCanaryHook(file: string): Promise<void> {
  const settings = Settings.parse(JSON.parse(await readFile(file, 'utf8').catch(() => '{}')));
  const print = `process.stdout.write(['frink','canary','hooks','${hex}'].join('_'))`;
  const group = { hooks: [{ type: 'command', command: `"${process.execPath}" -e "${print}"` }] };
  const prompts = [...(settings.hooks.UserPromptSubmit ?? []), group];
  await write(
    file,
    JSON.stringify({ ...settings, hooks: { ...settings.hooks, UserPromptSubmit: prompts } }),
  );
}

/** Plants every row in the user's own place, never at the path Frink delivers it to. */
export async function plantCanarySetup({ home, project }: { home: string; project: string }) {
  const claude = path.join(home, '.claude');
  // The CLI's own folder name for a project: its real path, every non-alphanumeric made "-".
  const projectDir = (await realpath(project)).replace(/[^a-zA-Z0-9]/g, '-');
  await write(path.join(project, 'AGENTS.md'), `House style. ${MARKS['instructions (project)']}\n`);
  await write(path.join(claude, 'CLAUDE.md'), `Answer briefly. ${MARKS.instructions}\n`);
  await write(
    path.join(claude, 'skills', 'frink-canary', 'SKILL.md'),
    described('Skill', MARKS.skills),
  );
  await write(path.join(claude, 'agents', 'frink-canary.md'), described('Agent', MARKS.agentBrain));
  await write(
    path.join(claude, 'projects', projectDir, 'memory', 'MEMORY.md'),
    `- ${MARKS.memory}\n`,
  );
  await mergeCanaryHook(path.join(claude, 'settings.json'));
  const server = path.join(home, 'frink-canary-mcp.mjs');
  await write(server, MCP_SERVER);
  await setGlobalMcpServer('frink-canary', {
    name: 'frink-canary',
    type: 'custom',
    authType: 'none',
    command: process.execPath,
    args: [server, hex],
  });
}

/** One test per row, each sharing one turn, and a precondition that never takes `fails`. */
export function registerCanaryRows(
  provider: CanaryProvider,
  bodies: () => Promise<string[]>,
  timeout: number,
): void {
  let seen: Promise<string[]> | undefined;
  const requests = () => (seen ??= bodies());
  it(`canary: the turn reached the model x ${provider}`, { timeout }, async () => {
    expect(await requests(), 'no request reached the model').not.toEqual([]);
  });
  for (const row of CANARY_ROWS) {
    const id: CanaryRowId = `${row} x ${provider}`;
    it(`canary: ${id}`, { fails: id in CANARY_GAPS, timeout }, async () => {
      const sent = (await requests()).join('\n');
      expect(sent, `${row} marker missing from the model request`).toContain(MARKS[row]);
    });
  }
}
