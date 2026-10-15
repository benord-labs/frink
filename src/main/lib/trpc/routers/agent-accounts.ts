import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { LAUNCH_FLAGS } from '../../../../shared/launch-flags';
import {
  AI_PROVIDER_IDS,
  aiProvider,
  selectableProviderIds,
} from '../../../../shared/lib/ai-providers';
import { findAcpAgent } from '../../agent-runner/acp';
import { rememberedAgentModels } from '../../agent-runner/agent-models';
import { findCopilotAgent } from '../../agent-runner/copilot';
import { detectCodexAccount } from '../../credentials/detect-codex';
import { claudeCodeCredentials, getDatabase } from '../../db';
import { createId } from '../../db/utils';
import { publicProcedure, router } from '../index';

type AgentAccountsDeps = {
  db: () => ReturnType<typeof getDatabase>;
  findAgent: (type: string) => ReturnType<typeof findAcpAgent>;
  findCopilot: typeof findCopilotAgent;
  detectCodex: typeof detectCodexAccount;
  rememberedModels: typeof rememberedAgentModels;
  flags: Partial<Record<keyof typeof LAUNCH_FLAGS, boolean>>;
  platform: string;
};

const NOT_AVAILABLE = "Frink can't connect this agent yet.";
const NO_CODEX_LOGIN = 'No Codex login found. Run `codex login` and try again.';
const typeInput = z.object({ type: z.string() });

type Detection =
  | { available: true; version?: string; email?: string; displayName?: string; sourcePath?: string }
  | { available: false; reason: string; missing?: true };

/** The provider row for an agent that keeps its own sign-in, when it may be connected here. */
function connectableAgent(type: string, deps: AgentAccountsDeps) {
  const row = aiProvider(type);
  const selectable = selectableProviderIds(deps.flags, deps.platform);
  return row && row.runtime !== 'claude' && selectable.includes(row.id) ? row : undefined;
}

/** Whether the agent's own sign-in or install is usable here; reads no secret. */
async function detectAgent(
  row: NonNullable<ReturnType<typeof connectableAgent>>,
  deps: AgentAccountsDeps,
): Promise<Detection> {
  if (row.runtime === 'codex') {
    const { hint, ...login } = await deps.detectCodex();
    return login.available
      ? { ...login, available: true }
      : { available: false, reason: hint ?? NO_CODEX_LOGIN };
  }
  const found = row.runtime === 'copilot' ? await deps.findCopilot() : await deps.findAgent(row.id);
  return 'reason' in found
    ? { ...found, available: false }
    : { available: true, version: found.version };
}

/** Finds and connects agents that keep their own sign-in, so Frink stores no credential for them. */
export function createAgentAccountsRouter(
  deps: AgentAccountsDeps = {
    db: getDatabase,
    findAgent: findAcpAgent,
    findCopilot: findCopilotAgent,
    detectCodex: detectCodexAccount,
    rememberedModels: rememberedAgentModels,
    flags: LAUNCH_FLAGS,
    platform: process.platform,
  },
) {
  return router({
    detect: publicProcedure.input(typeInput).query(async ({ input }): Promise<Detection> => {
      const row = connectableAgent(input.type, deps);
      return row ? detectAgent(row, deps) : { available: false, reason: NOT_AVAILABLE };
    }),

    /** The models the agent last reported on this computer; none before its first session. */
    models: publicProcedure
      .input(typeInput)
      .query(({ input }) => deps.rememberedModels(input.type)),

    /** One row per agent on this computer; connecting again refreshes it. */
    connect: publicProcedure
      .input(typeInput.extend({ accountLabel: z.string().min(1).optional() }))
      .mutation(async ({ input }) => {
        const row = connectableAgent(input.type, deps);
        if (!row) throw new Error(NOT_AVAILABLE);
        const found = await detectAgent(row, deps);
        if (!found.available) throw new Error(found.reason);
        const expectedEmail = found.email ?? null;

        const db = deps.db();
        const existing = db
          .select({ id: claudeCodeCredentials.id })
          .from(claudeCodeCredentials)
          .where(eq(claudeCodeCredentials.source, row.passthroughSource))
          .get();
        if (existing) {
          // With no label given, the stored one stays.
          db.update(claudeCodeCredentials)
            .set({
              accountLabel: input.accountLabel,
              expectedEmail,
              needsReauthAt: null,
              connectedAt: new Date(),
            })
            .where(eq(claudeCodeCredentials.id, existing.id))
            .run();
          return { accountId: existing.id, status: 'updated' as const };
        }
        // The same table holds tokens that are not AI accounts, which never count here.
        const firstAccount = !db
          .select({ id: claudeCodeCredentials.id })
          .from(claudeCodeCredentials)
          .where(inArray(claudeCodeCredentials.type, AI_PROVIDER_IDS))
          .get();
        const id = createId();
        db.insert(claudeCodeCredentials)
          .values({
            id,
            type: row.id,
            accountLabel: input.accountLabel ?? row.name,
            oauthToken: null,
            isDefault: firstAccount,
            source: row.passthroughSource,
            sourcePath: found.sourcePath ?? null,
            expectedEmail,
          })
          .run();
        return { accountId: id, status: 'created' as const };
      }),
  });
}

export const agentAccountsRouter = createAgentAccountsRouter();
