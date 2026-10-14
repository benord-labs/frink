import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { LAUNCH_FLAGS } from '../../../../shared/launch-flags';
import {
  AI_PROVIDER_IDS,
  aiProvider,
  selectableProviderIds,
} from '../../../../shared/lib/ai-providers';
import { findAcpAgent, rememberedModelOptions } from '../../agent-runner/acp';
import { claudeCodeCredentials, getDatabase } from '../../db';
import { createId } from '../../db/utils';
import { publicProcedure, router } from '../index';

type AgentAccountsDeps = {
  db: () => ReturnType<typeof getDatabase>;
  findAgent: (type: string) => ReturnType<typeof findAcpAgent>;
  rememberedModels: typeof rememberedModelOptions;
  flags: Partial<Record<keyof typeof LAUNCH_FLAGS, boolean>>;
  platform: string;
};

const NOT_AVAILABLE = "Frink can't connect this agent yet.";
const typeInput = z.object({ type: z.string() });

/** The provider row for an agent Frink runs from the user's own install, when it may be connected here. */
function connectableAgent(type: string, deps: AgentAccountsDeps) {
  const row = aiProvider(type);
  const selectable = selectableProviderIds(deps.flags, deps.platform);
  return row?.runtime === 'acp' && selectable.includes(row.id) ? row : undefined;
}

/** Finds and connects agents that keep their own sign-in, so Frink stores no credential for them. */
export function createAgentAccountsRouter(
  deps: AgentAccountsDeps = {
    db: getDatabase,
    findAgent: findAcpAgent,
    rememberedModels: rememberedModelOptions,
    flags: LAUNCH_FLAGS,
    platform: process.platform,
  },
) {
  return router({
    detect: publicProcedure.input(typeInput).query(async ({ input }) => {
      const row = connectableAgent(input.type, deps);
      const found = row ? await deps.findAgent(row.id) : { reason: NOT_AVAILABLE };
      if ('reason' in found) return { available: false, reason: found.reason };
      return { available: true, version: found.version };
    }),

    /** The models the agent listed in its last session this run; none until it has run once. */
    models: publicProcedure
      .input(typeInput)
      .query(({ input }) => deps.rememberedModels(input.type) ?? []),

    /** One row per agent on this computer; connecting again refreshes it. */
    connect: publicProcedure
      .input(typeInput.extend({ accountLabel: z.string().min(1).optional() }))
      .mutation(async ({ input }) => {
        const row = connectableAgent(input.type, deps);
        if (!row) throw new Error(NOT_AVAILABLE);
        const found = await deps.findAgent(row.id);
        if ('reason' in found) throw new Error(found.reason);

        const db = deps.db();
        const existing = db
          .select({ id: claudeCodeCredentials.id })
          .from(claudeCodeCredentials)
          .where(eq(claudeCodeCredentials.source, row.passthroughSource))
          .get();
        if (existing) {
          // With no label given, the stored one stays.
          db.update(claudeCodeCredentials)
            .set({ accountLabel: input.accountLabel, needsReauthAt: null, connectedAt: new Date() })
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
          })
          .run();
        return { accountId: id, status: 'created' as const };
      }),
  });
}

export const agentAccountsRouter = createAgentAccountsRouter();
