import path from 'node:path';
import { isPlainObject } from '../../../../shared/lib/case-converter';
import type { CodexApprovalRequest } from './codex-events';

export const FRINK_HOST_TOOL_PERMISSION_VERSION = 1 as const;
export const FRINK_HOST_TOOL_PERMISSION_METHOD = 'frink/toolPermission/request' as const;

type FrinkHostToolPermissionKind = 'command' | 'writeStdin' | 'applyPatch' | 'mcp';

type FrinkPatchEffect = {
  operation: 'add' | 'delete' | 'update' | 'move';
  path: string;
  destination?: string;
};

type FrinkMcpIdentity = {
  server: string;
  tool: string;
};

export type FrinkHostToolPermissionRequest = {
  protocolVersion: typeof FRINK_HOST_TOOL_PERMISSION_VERSION;
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  kind: FrinkHostToolPermissionKind;
  toolName: string;
  input: Record<string, unknown>;
  cwd?: string | null;
  patchEffects?: FrinkPatchEffect[];
  mcp?: FrinkMcpIdentity;
};

type ApprovedMcpCall = {
  threadId: string;
  turnId: string;
  itemId: string;
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
};

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isKind(value: unknown): value is FrinkHostToolPermissionKind {
  return value === 'command' || value === 'writeStdin' || value === 'applyPatch' || value === 'mcp';
}

function isPatchOperation(value: unknown): value is FrinkPatchEffect['operation'] {
  return value === 'add' || value === 'delete' || value === 'update' || value === 'move';
}

function parseOptionalDestination(value: unknown): string | null | undefined {
  return value === undefined ? undefined : requiredString(value);
}

function buildPatchEffect(
  operation: FrinkPatchEffect['operation'],
  effectPath: string,
  destination: string | undefined,
): FrinkPatchEffect | undefined {
  if (operation === 'move') {
    return destination ? { operation, path: effectPath, destination } : undefined;
  }
  return destination === undefined ? { operation, path: effectPath } : undefined;
}

function parsePatchEffect(value: unknown): FrinkPatchEffect | undefined {
  if (!isPlainObject(value)) return undefined;
  const effectPath = requiredString(value.path);
  const operation = value.operation;
  if (!effectPath || !isPatchOperation(operation)) return undefined;

  const destination = parseOptionalDestination(value.destination);
  return destination === null ? undefined : buildPatchEffect(operation, effectPath, destination);
}

function parsePatchEffects(value: unknown): FrinkPatchEffect[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const effects = value.map(parsePatchEffect);
  return effects.some((effect) => effect === undefined)
    ? undefined
    : (effects as FrinkPatchEffect[]);
}

function parseMcpIdentity(value: unknown): FrinkMcpIdentity | undefined {
  if (!isPlainObject(value)) return undefined;
  const server = requiredString(value.server);
  const tool = requiredString(value.tool);
  return server && tool ? { server, tool } : undefined;
}

function hasValidOptionalFields(value: Record<string, unknown>): boolean {
  const validApprovalId =
    value.approvalId === undefined ||
    value.approvalId === null ||
    typeof value.approvalId === 'string';
  const validCwd = value.cwd === undefined || value.cwd === null || typeof value.cwd === 'string';
  return validApprovalId && validCwd;
}

function hasValidCommandPayload(request: FrinkHostToolPermissionRequest): boolean {
  return (
    requiredString(request.input.command) !== null &&
    typeof request.cwd === 'string' &&
    path.isAbsolute(request.cwd)
  );
}

function hasValidPatchPayload(request: FrinkHostToolPermissionRequest): boolean {
  return (
    typeof request.cwd === 'string' &&
    path.isAbsolute(request.cwd) &&
    Boolean(request.patchEffects?.length)
  );
}

function hasValidMcpPayload(request: FrinkHostToolPermissionRequest): boolean {
  return (
    request.mcp !== undefined &&
    request.toolName === `mcp__${request.mcp.server}__${request.mcp.tool}`
  );
}

const KIND_PAYLOAD_VALIDATORS: Record<
  FrinkHostToolPermissionKind,
  (request: FrinkHostToolPermissionRequest) => boolean
> = {
  command: hasValidCommandPayload,
  writeStdin: hasValidCommandPayload,
  applyPatch: hasValidPatchPayload,
  mcp: hasValidMcpPayload,
};

export function parseFrinkHostToolPermissionRequest(
  value: unknown,
): FrinkHostToolPermissionRequest | null {
  if (!isPlainObject(value) || value.protocolVersion !== FRINK_HOST_TOOL_PERMISSION_VERSION)
    return null;
  const threadId = requiredString(value.threadId);
  const turnId = requiredString(value.turnId);
  const itemId = requiredString(value.itemId);
  const toolName = requiredString(value.toolName);
  const requiredFields = [threadId, turnId, itemId, toolName];
  if (requiredFields.includes(null) || !isKind(value.kind) || !isPlainObject(value.input))
    return null;
  if (!hasValidOptionalFields(value)) return null;

  const patchEffects = parsePatchEffects(value.patchEffects);
  if (value.patchEffects !== undefined && patchEffects === undefined) return null;

  const mcp = parseMcpIdentity(value.mcp);
  if (value.mcp !== undefined && mcp === undefined) return null;

  const request: FrinkHostToolPermissionRequest = {
    protocolVersion: FRINK_HOST_TOOL_PERMISSION_VERSION,
    threadId: threadId as string,
    turnId: turnId as string,
    itemId: itemId as string,
    approvalId: value.approvalId as string | null | undefined,
    kind: value.kind,
    toolName: toolName as string,
    input: value.input,
    cwd: value.cwd as string | null | undefined,
    ...(patchEffects && { patchEffects }),
    ...(mcp && { mcp }),
  };
  return KIND_PAYLOAD_VALIDATORS[request.kind](request) ? request : null;
}

function patchApprovalRequests(
  cwd: string | null | undefined,
  effects: FrinkPatchEffect[] | undefined,
): CodexApprovalRequest[] {
  const requests = new Map<string, CodexApprovalRequest>();
  const add = (toolName: 'Delete' | 'Edit' | 'Write', filePath: string) => {
    const resolved = path.resolve(cwd ?? '', filePath);
    requests.set(`${toolName}\0${resolved}`, { toolName, input: { file_path: resolved } });
  };
  for (const effect of effects ?? []) {
    if (effect.operation === 'add') add('Write', effect.path);
    if (effect.operation === 'delete') add('Delete', effect.path);
    if (effect.operation === 'update') add('Edit', effect.path);
    if (effect.operation === 'move' && effect.destination) {
      add('Delete', effect.path);
      add('Write', effect.destination);
    }
  }
  return [...requests.values()].sort((left, right) =>
    fingerprint(left).localeCompare(fingerprint(right)),
  );
}

export function mapFrinkHostPermissionRequests(
  request: FrinkHostToolPermissionRequest,
): CodexApprovalRequest[] {
  if (request.kind === 'applyPatch') {
    return patchApprovalRequests(request.cwd, request.patchEffects);
  }
  if (request.kind === 'mcp') {
    return [{ toolName: request.toolName, input: request.input, mcp: request.mcp }];
  }
  return [
    {
      toolName: 'Bash',
      input: {
        command: request.input.command as string,
        ...(request.cwd ? { cwd: request.cwd } : {}),
      },
    },
  ];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function fingerprint(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export class CodexHostPermissionDeduper {
  private readonly mcpCalls = new Map<string, ApprovedMcpCall>();

  private mcpKey(threadId: string, turnId: string, itemId: string): string {
    return fingerprint({ threadId, turnId, itemId });
  }

  remember(request: FrinkHostToolPermissionRequest): void {
    if (request.kind === 'mcp' && request.mcp) {
      this.mcpCalls.set(this.mcpKey(request.threadId, request.turnId, request.itemId), {
        threadId: request.threadId,
        turnId: request.turnId,
        itemId: request.itemId,
        server: request.mcp.server,
        tool: request.mcp.tool,
        arguments: request.input,
      });
    }
  }

  consumeMcp(
    threadId: string,
    turnId: string,
    itemId: string,
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): boolean {
    const key = this.mcpKey(threadId, turnId, itemId);
    const approved = this.mcpCalls.get(key);
    if (!approved) return false;
    this.mcpCalls.delete(key);
    return (
      approved.threadId === threadId &&
      approved.turnId === turnId &&
      approved.server === server &&
      approved.tool === tool &&
      fingerprint(approved.arguments) === fingerprint(args)
    );
  }

  clearTurn(threadId: string, turnId: string): void {
    for (const [key, call] of this.mcpCalls) {
      if (call.threadId === threadId && call.turnId === turnId) this.mcpCalls.delete(key);
    }
  }
}

export const codexHostPermissionDeduper = new CodexHostPermissionDeduper();
