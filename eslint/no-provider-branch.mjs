// Provider-specific code lives in that provider's adapter, never in feature code.
// Existing hits are counted in eslint/baselines/provider-branches.json, and the counts only shrink.

/** Provider and runtime ids. Its test keeps this equal to AI_PROVIDER_IDS plus AGENT_RUNTIMES. */
export const PROVIDER_IDS = [
  'claude',
  'claude-code',
  'codex',
  'acp',
  'copilot',
  'cursor',
  'opencode',
  'grok',
];

/** Each provider's adapter, by exact folder or file. Its test checks every entry exists. */
export const PROVIDER_ADAPTER_PATHS = [
  'src/main/lib/agent-runner/acp/**',
  'src/main/lib/agent-runner/codex/**',
  'src/main/lib/agent-runner/copilot/**',
  'src/main/lib/agent-runner/cursor/**',
  'src/main/lib/socket/codex-session/**',
  'src/main/lib/socket/execution/acp-turn/**',
  'src/main/lib/socket/execution/copilot-turn/**',
  'src/main/lib/socket/execution/cursor-turn/**',
  'src/main/lib/claude/**',
  'src/main/lib/socket/execution/claude-session/**',
  'src/main/lib/socket/execution/claude-session-loop.ts',
  'src/main/lib/socket/execution/claude-provider-cleanup.ts',
  'src/main/lib/socket/claude-input-queue.ts',
  'src/main/lib/socket/claude-session-registry.ts',
  'src/main/lib/socket/claude-turn-context.ts',
  'src/main/lib/socket/claude-wake-hold.ts',
  'src/shared/lib/ai-providers/index.ts',
];

const PROVIDER_NAME = /^is(?:Claude|Codex|Acp|Copilot|Cursor|OpenCode|Grok)(?![a-z])/;
const MEMBERSHIP_METHODS = ['includes', 'has', 'indexOf'];

function isProviderLiteral(node) {
  return node?.type === 'Literal' && PROVIDER_IDS.includes(node.value);
}

function isFunction(node) {
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression';
}

function* scopesUnder(scope) {
  yield scope;
  for (const child of scope.childScopes) yield* scopesUnder(child);
}

/** A boolean variable or parameter named for a provider, e.g. isCodex or a destructured isCodexProject. */
function isProviderBoolean(variable) {
  const def = variable.defs[0];
  if (!def || !PROVIDER_NAME.test(variable.name)) return false;
  return def.type === 'Parameter' || (def.type === 'Variable' && !isFunction(def.node.init));
}

/** Provider literals in a membership check: list.includes('codex') or ['codex', 'acp'].includes(id). */
function membershipLiterals(call) {
  if (!MEMBERSHIP_METHODS.includes(call.callee.property?.name)) return [];
  const owner = call.callee.object;
  const listed = owner.type === 'ArrayExpression' ? owner.elements : [];
  return [call.arguments[0], ...listed].filter(isProviderLiteral);
}

/** @type {import('eslint').Rule.RuleModule} */
export const noProviderBranch = {
  meta: {
    type: 'problem',
    docs: {
      description: "Provider branches belong in that provider's adapter, not in feature code.",
    },
    messages: {
      branch:
        '"{{id}}" branches on a provider outside its adapter. Read the capability row in src/shared/lib/ai-providers or move this into the adapter. Existing ones are counted in eslint/baselines/provider-branches.json and only shrink: after removing one, run `bun run lint:structure --prune-suppressions`.',
    },
    schema: [],
  },
  create(context) {
    const report = (node, id) => context.report({ node, messageId: 'branch', data: { id } });
    return {
      'BinaryExpression[operator=/^[!=]==?$/]'(node) {
        for (const side of [node.left, node.right])
          if (isProviderLiteral(side)) report(side, side.value);
      },
      SwitchCase(node) {
        if (isProviderLiteral(node.test)) report(node.test, node.test.value);
      },
      'CallExpression[callee.type="MemberExpression"]'(node) {
        for (const literal of membershipLiterals(node)) report(literal, literal.value);
      },
      'Program:exit'(program) {
        for (const scope of scopesUnder(context.sourceCode.getScope(program)))
          for (const variable of scope.variables)
            if (isProviderBoolean(variable)) report(variable.identifiers[0], variable.name);
      },
    };
  },
};
