import { TRPCError } from '@trpc/server';
import {
  mobileRequestSchema,
  type MobileRequest,
  type MobileResponses,
} from '../../../../shared/types/remote/mobile';
import {
  answerMobileQuestion,
  createMobileChat,
  readMobileChat,
  respondMobilePermission,
  sendMobileMessage,
  stopMobileChat,
} from './chat';
import { MobileApiError, mobileCallers, requireExecutionReady } from './context';
import { readMobileFlow, readMobileFlows, readMobileRun, resumeMobileNode } from './flows';
import { readMobileChats, readMobileOverview, readMobileProjects } from './read';

// Reason: An exhaustive command switch keeps this transport boundary explicit.
// fallow-ignore-next-line complexity
async function dispatch(request: MobileRequest): Promise<MobileResponses[MobileRequest['type']]> {
  switch (request.type) {
    case 'overview':
      return readMobileOverview();
    case 'flows':
      return readMobileFlows();
    case 'flow':
      return readMobileFlow(request.id);
    case 'run':
      return readMobileRun(request.id);
    case 'chats':
      return readMobileChats();
    case 'projects':
      return readMobileProjects();
    case 'chat':
      return readMobileChat(request);
    case 'createChat':
      return createMobileChat(request);
    case 'sendMessage':
      return sendMobileMessage(request);
    case 'stopChat':
      return stopMobileChat(request);
    case 'answerQuestion':
      return answerMobileQuestion(request);
    case 'respondPermission':
      return respondMobilePermission(request);
    case 'resumeNode':
      return resumeMobileNode(request);
    case 'startFlow': {
      requireExecutionReady();
      const run = await mobileCallers.flows.startRun({
        flowId: request.id,
        idempotencyKey: `mobile:${request.requestId}`,
      });
      return { id: run.id };
    }
    case 'setFlowEnabled':
      await mobileCallers.flows.update({ id: request.id, is_enabled: request.enabled });
      return { ok: true };
    case 'cancelRun':
      // The Flow engine aborts registered providers before persisting cancellation.
      await mobileCallers.flows.cancelRun({ runId: request.id });
      return { ok: true };
  }
}

export async function executeMobileRequest(
  request: MobileRequest,
): Promise<MobileResponses[MobileRequest['type']]> {
  const parsed = mobileRequestSchema.safeParse(request);
  if (!parsed.success) throw new MobileApiError(400, 'Invalid mobile request.');
  try {
    return await dispatch(parsed.data);
  } catch (error) {
    if (error instanceof MobileApiError) throw error;
    if (error instanceof TRPCError && error.code === 'NOT_FOUND')
      throw new MobileApiError(404, 'This item no longer exists.');
    if (error instanceof TRPCError && ['CONFLICT', 'PRECONDITION_FAILED'].includes(error.code)) {
      throw new MobileApiError(409, 'This item changed. Refresh and try again.');
    }
    throw new MobileApiError(500, 'Frink could not complete this request. Try again.');
  }
}
