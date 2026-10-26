import path from 'node:path';
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node';
import { z } from 'zod';
import {
  reportStagedNotLoaded,
  STAGED_VS_LOADED_SURFACE,
  skillFolders,
} from '../../../provider/staged-vs-loaded';
import { captureMainException } from '../../../sentry/init';
import type { CodexAppServerClient } from '../app-server-client';
import { getCodexSkillRootsRpcOutcome } from '../skill-roots';

// Not compared: hooks, as hooks/list leaves out the hooks a thread is started with.

const McpPage = z.object({
  data: z.array(z.object({ name: z.string() })),
  nextCursor: z.string().nullish(),
});
const SkillsList = z.object({
  data: z.array(z.object({ skills: z.array(z.object({ path: z.string() })) })),
});
const MAX_PAGES = 10;

type Client = Pick<CodexAppServerClient, 'sendRequest'>;
/** What a fresh thread was handed: Frink's MCP server names and the vendor skill roots. */
export type CodexStaged = {
  subChatId: string;
  cwd: string;
  mcpServers: string[];
  skillRoots: string[];
};

/** Every MCP server the thread lists. A cursor still left after MAX_PAGES leaves the category out. */
async function loadedMcpServers(client: Client, threadId: string): Promise<string[] | undefined> {
  const names: string[] = [];
  let cursor: string | null | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = { threadId, detail: 'toolsAndAuthOnly', cursor };
    const listed = McpPage.parse(await client.sendRequest('mcpServerStatus/list', params));
    names.push(...listed.data.map((server) => server.name));
    cursor = listed.nextCursor;
    if (!cursor) return names;
  }
  return undefined;
}

/** The folder of every skill Codex lists, as Codex names a skill by its frontmatter instead. */
async function loadedSkillFolders(client: Client, cwd: string): Promise<string[]> {
  const listed = SkillsList.parse(await client.sendRequest('skills/list', { cwds: [cwd] }));
  return listed.data.flatMap((entry) =>
    entry.skills.map((skill) => path.basename(path.dirname(skill.path))),
  );
}

const stagedSkillFolders = async (roots: string[]) => [
  ...new Set((await Promise.all(roots.map(skillFolders))).flat()),
];

/** A stop or a restart disposed the app-server, so there is nothing left to compare. */
const appServerGone = (error: Error) =>
  error instanceof ResponseError && error.code === ErrorCodes.PendingResponseRejected;

/** Compares what a fresh thread was handed with what the app-server lists. The turn never awaits it. */
export function checkCodexThreadLoaded(
  client: Client,
  threadId: string,
  staged: CodexStaged,
): Promise<void> {
  // A failed roots RPC is already captured where it is sent.
  const skills = staged.skillRoots.length > 0 && getCodexSkillRootsRpcOutcome()?.ok !== false;
  const servers = staged.mcpServers.length > 0;
  if (!servers && !skills) return Promise.resolve();
  return Promise.all([
    servers ? loadedMcpServers(client, threadId) : undefined,
    skills ? loadedSkillFolders(client, staged.cwd) : undefined,
    skills ? stagedSkillFolders(staged.skillRoots) : [],
  ])
    .then(([mcpServers, loadedSkills, stagedSkills]) =>
      reportStagedNotLoaded(
        'codex',
        staged.subChatId,
        { mcpServers: staged.mcpServers, skills: stagedSkills },
        { mcpServers, skills: loadedSkills },
      ),
    )
    .catch((error: Error) => {
      if (!appServerGone(error)) captureMainException(error, { surface: STAGED_VS_LOADED_SURFACE });
    });
}
