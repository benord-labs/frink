import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tsParser from '@typescript-eslint/parser';
import { ESLint, RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import {
  noProviderBranch,
  PROVIDER_ADAPTER_PATHS,
  PROVIDER_IDS,
} from '../../eslint/no-provider-branch.mjs';
import { AGENT_RUNTIMES, AI_PROVIDER_IDS } from '../../src/shared/lib/ai-providers/index.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BASELINE = 'eslint/baselines/provider-branches.json';

const readJson = (file) => JSON.parse(readFileSync(join(ROOT, file), 'utf8'));

// vitest has no globals: RuleTester registers its cases through these.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
});
const errors = (count) => Array.from({ length: count }, () => ({ messageId: 'branch' }));

ruleTester.run('no-provider-branch', noProviderBranch, {
  valid: [
    'if (row.capabilities.plan) send();',
    'const adapter = HOOK_ADAPTERS[runtime];',
    "if (style.cursor === 'pointer') move();",
    'const isInstalled = isInstalledAgent(row);',
    "function isCodexSpeed(value: string) { return value === 'fast'; }",
    'const isCodexMirror = (text: string) => text.startsWith(MARK);',
    "import { isClaudeOAuthToken } from './token';",
    "const label = { codex: 'OpenAI' };",
    'type Props = { isCodexProject: boolean };',
    "if (tags.includes('pointer')) go();",
    "const ok = ['a', 'b'].includes(x);",
    'const ok = ADAPTERS.has(runtime);',
  ],
  invalid: [
    { code: "if (agentRuntime === 'codex') run();", errors: errors(1) },
    { code: "if ('cursor' !== row.runtime) skip();", errors: errors(1) },
    { code: "const ok = type == 'claude-code';", errors: errors(1) },
    { code: "const isCodex = agentRuntime === 'codex';", errors: errors(2) },
    { code: 'const isCodex = row.flag;', errors: errors(1) },
    { code: 'const { isCodexProject } = useProjectModelOptions();', errors: errors(1) },
    { code: 'function pick(isClaude = false) { return isClaude; }', errors: errors(1) },
    {
      code: 'function F({ isCodexProject }: { isCodexProject: boolean }) { return isCodexProject; }',
      errors: errors(1),
    },
    {
      code: "switch (runtime) { case 'acp': break; case 'copilot': break; default: break; }",
      errors: errors(2),
    },
    { code: "const x = provider === 'opencode' || provider === 'grok';", errors: errors(2) },
    { code: "const a = signIns.includes('claude-code') ? null : key;", errors: errors(1) },
    { code: "const a = ['codex', 'acp'].includes(runtime);", errors: errors(2) },
    { code: "const a = seen.has('codex');", errors: errors(1) },
    { code: "const a = rows?.indexOf('cursor');", errors: errors(1) },
  ],
});

describe('no-provider-branch wiring', () => {
  it('knows every provider and runtime id', () => {
    const ids = new Set([...AGENT_RUNTIMES, ...AI_PROVIDER_IDS]);
    expect([...PROVIDER_IDS].sort()).toEqual([...ids].sort());
  });

  it('runs on feature code and skips adapters and tests', async () => {
    const eslint = new ESLint({ cwd: ROOT });
    const isOn = async (file) =>
      (await eslint.calculateConfigForFile(file)).rules?.['frink/no-provider-branch'] !== undefined;
    expect(await isOn('src/main/lib/socket/executor.ts')).toBe(true);
    expect(await isOn('src/renderer/lib/ai-providers/chat-options.ts')).toBe(true);
    expect(await isOn('src/main/lib/agent-runner/codex/codex-usage.ts')).toBe(false);
    expect(await isOn('src/main/lib/socket/execution/claude-session/prewarm.ts')).toBe(false);
    expect(await isOn('src/main/lib/socket/executor.test.ts')).toBe(false);
    expect(await isOn('mobile/src/screens/Chat/Composer/sheets.tsx')).toBe(true);
    expect(await isOn('mobile/tests/fixtures/sim-relay.ts')).toBe(false);
  });

  it('allowlists only adapter paths that exist', () => {
    const missing = PROVIDER_ADAPTER_PATHS.filter(
      (path) => !existsSync(join(ROOT, path.replace(/\/\*\*$/, ''))),
    );
    expect(missing).toEqual([]);
  });

  it('keeps the baseline to this rule, live files and the strict lint script', () => {
    for (const [file, rules] of Object.entries(readJson(BASELINE))) {
      expect(Object.keys(rules), file).toEqual(['frink/no-provider-branch']);
      expect(existsSync(join(ROOT, file)), `${file}: run --prune-suppressions`).toBe(true);
    }
    const script = readJson('package.json').scripts['lint:structure'];
    expect(script).toContain(`--suppressions-location ${BASELINE}`);
    expect(script.split(' ')).toContain('mobile');
    expect(script).not.toContain('--pass-on-unpruned-suppressions');
  });
});

// A disable naming a frink rule, a `/* eslint frink/…: off */` config comment, or a rule-less disable.
const BYPASS =
  /eslint-disable.*frink\/|\/\*\s*eslint\s[^*]*frink\/|eslint-disable(?:-next-line|-line)?(?=\s*(?:\*\/|--|$))/m;

describe('frink rules', () => {
  it('are never bypassed with an inline eslint comment', () => {
    const bypasses = ['src', 'mobile/src']
      .flatMap((dir) => readdirSync(join(ROOT, dir), { recursive: true }).map((f) => join(dir, f)))
      .filter((file) => /\.tsx?$/.test(file))
      .filter((file) => BYPASS.test(readFileSync(join(ROOT, file), 'utf8')));
    expect(bypasses, 'name the rule, or allowlist the path in eslint.config.mjs').toEqual([]);
  });
});
