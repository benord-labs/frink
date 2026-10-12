import { isPlainObject } from '../../../shared/lib/case-converter';
import { flowChangeStringValue } from '../../../shared/lib/flows/flow-change-text';
import { isSpilledToolResultText, unwrapMcpOutput } from '../../../shared/lib/mcp-output';
import type { FlowChangePhase } from '../../../shared/types/flows/flow-change-presentation';
import { FLOW_PATCH_VERSION_CONFLICT_CODE } from '../../../shared/types/flows/flow-change-presentation';

export type FlowToolPart = {
  state?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  result?: unknown;
  errorText?: string;
};

function outputErrorMessage(output: Record<string, unknown> | undefined): string | undefined {
  if (typeof output?.error === 'string') return output.error;
  if (isPlainObject(output?.error) && typeof output.error.message === 'string') {
    return output.error.message;
  }
  return undefined;
}

function rawOutput(part: FlowToolPart): Record<string, unknown> | undefined {
  const value = unwrapMcpOutput(part.output ?? part.result);
  const output = isPlainObject(value) ? value : undefined;
  const nestedError = unwrapMcpOutput(outputErrorMessage(output));
  const errorReceipt = unwrapMcpOutput(part.errorText);
  if (!output && !isPlainObject(nestedError) && !isPlainObject(errorReceipt)) return undefined;
  return {
    ...output,
    ...(isPlainObject(nestedError) ? nestedError : {}),
    ...(isPlainObject(errorReceipt) ? errorReceipt : {}),
  };
}

function isDeniedReceipt(
  output: Record<string, unknown> | undefined,
  errorMessage: string | undefined,
): boolean {
  return (
    output?.permissionDenied === true ||
    output?.rejected === true ||
    errorMessage === 'User denied the MCP tool call.'
  );
}

function isStaleReceipt(
  output: Record<string, unknown> | undefined,
  errorMessage: string | undefined,
): boolean {
  return Boolean(
    output?.errorCode === FLOW_PATCH_VERSION_CONFLICT_CODE ||
    errorMessage?.startsWith('Failed to save patched flow version (conflict):') ||
    errorMessage?.includes('Flow version conflict'),
  );
}

function hasRecognizedSuccessPersistence(output: Record<string, unknown>): boolean {
  return (
    output.persistence === undefined ||
    output.persistence === 'saved' ||
    output.persistence === 'unchanged'
  );
}

function successfulReceiptPhase(output: Record<string, unknown>): FlowChangePhase {
  if (!flowChangeStringValue(output.flowId) || !hasRecognizedSuccessPersistence(output)) {
    return 'unconfirmed';
  }
  return output.persistence === 'unchanged' ? 'unchanged' : 'applied';
}

function receiptPhase(output: Record<string, unknown> | undefined): FlowChangePhase | undefined {
  if (output?.status === 'partial') {
    return flowChangeStringValue(output.flowId) && hasRecognizedSuccessPersistence(output)
      ? 'partial'
      : 'unconfirmed';
  }
  if (output?.status === 'failure') return 'unconfirmed';
  return output?.status === 'success' ? successfulReceiptPhase(output) : undefined;
}

function errorPhase(
  output: Record<string, unknown> | undefined,
  errorMessage: string | undefined,
): FlowChangePhase | undefined {
  if (isDeniedReceipt(output, errorMessage)) return 'denied';
  return isStaleReceipt(output, errorMessage) ? 'stale' : undefined;
}

/** Whether the unwrapped tool body is a spill note, read exactly as the phase reads it. */
function isSpilledToolOutput(part: Pick<FlowToolPart, 'output' | 'result'>): boolean {
  const body = flowChangeStringValue(unwrapMcpOutput(part.output ?? part.result));
  return isSpilledToolResultText(body ?? '');
}

/** The harness left a note in place of an oversized result, bare or as a nested error. */
function isSpilledResult(part: FlowToolPart, nestedError: string | undefined): boolean {
  return (
    [part.errorText, nestedError].some((text) => isSpilledToolResultText(text ?? '')) ||
    isSpilledToolOutput(part)
  );
}

function nonErrorPhase(
  part: FlowToolPart,
  output: Record<string, unknown> | undefined,
  interrupted: boolean,
): FlowChangePhase {
  if (output?.status === 'failure' && output.persistence === 'none') return 'failed';
  // Only a result with no receipt status counts: the tool finished, its outcome is unread.
  if (output?.status === undefined && isSpilledResult(part, outputErrorMessage(output))) {
    return 'unread';
  }
  if (part.state === 'output-error') return 'unconfirmed';
  return receiptPhase(output) ?? unfinishedPhase(part.state, interrupted);
}

function unfinishedPhase(state: string | undefined, interrupted: boolean): FlowChangePhase {
  if (interrupted) return 'interrupted';
  if (state === 'output-available') return 'unconfirmed';
  return state === 'input-streaming' ? 'proposed' : 'applying';
}

function phaseFor(
  part: FlowToolPart,
  output: Record<string, unknown> | undefined,
  interrupted: boolean,
): FlowChangePhase {
  const errorMessage = part.errorText ?? outputErrorMessage(output);
  return errorPhase(output, errorMessage) ?? nonErrorPhase(part, output, interrupted);
}

export { phaseFor, rawOutput };
