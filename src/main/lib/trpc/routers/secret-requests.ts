/**
 * tRPC router — the secure secret form. The value arrives here once, goes to the env file, and is
 * never logged, stored or echoed; the agent hears only the fixed message main sends it.
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  answerSecretRequest,
  openSecretRequest,
  type SecretAnswer,
} from '../../mcp/secret-request/answer';
import { SecretRequestError } from '../../mcp/secret-request/env-file';
import { getLiveSecretRequest } from '../../mcp/secret-request/store';
import { ChatBusyError, DuplicateMessageError } from '../../socket/execution/send-admission';
import { publicProcedure, router } from '../index';

const requestRef = z.object({
  subChatId: z.string().min(1),
  requestId: z.string().min(1),
  /** The parked task carrying the request; null for a chat with no task. */
  taskId: z.string().nullable(),
});

async function answer(input: SecretAnswer): Promise<{ ok: true }> {
  const request = await openSecretRequest(input);
  if (!request) throw new TRPCError({ code: 'NOT_FOUND', message: 'This request has closed.' });
  try {
    await answerSecretRequest(request, input);
  } catch (error) {
    // Plain messages for the card; only our own refusals pass through, as others could quote content.
    if (error instanceof SecretRequestError) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
    }
    if (error instanceof ChatBusyError || error instanceof DuplicateMessageError) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'The agent is busy. Try again in a moment.',
      });
    }
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Frink could not finish this.' });
  }
  return { ok: true };
}

export const secretRequestsRouter = router({
  /** The open request of a chat with no task to park; parked requests ride on the task row. */
  pending: publicProcedure
    .input(z.object({ subChatId: z.string().min(1) }))
    .query(({ input }) => getLiveSecretRequest(input.subChatId)),

  submit: publicProcedure
    .input(requestRef.extend({ value: z.string() }))
    .mutation(({ input }) => answer(input)),

  decline: publicProcedure
    .input(requestRef)
    .mutation(({ input }) => answer({ ...input, value: null })),
});
