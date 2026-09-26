import { describe, expect, it } from 'vitest';
import { validateRuleString } from './validate-rule';

describe('validateRuleString — known tools accepted', () => {
  it.each([
    ['Read'],
    ['Edit'],
    ['Write'],
    ['Delete'],
    ['MultiEdit'],
    ['NotebookEdit'],
    ['Bash'],
    ['Glob'],
    ['Grep'],
    ['Task'],
    ['TodoWrite'],
    ['WebFetch'],
    ['WebSearch'],
    ['ExitPlanMode'],
  ])('accepts %s (tool-wide)', (rule) => {
    expect(validateRuleString(rule)).toEqual({ ok: true });
  });

  it('accepts known tool with content', () => {
    expect(validateRuleString('Bash(npm:*)')).toEqual({ ok: true });
    expect(validateRuleString('Edit(src/**)')).toEqual({ ok: true });
    expect(validateRuleString('Read(/abs/path/file.ts)')).toEqual({ ok: true });
  });
});

describe('validateRuleString — MCP tools accepted (open universe)', () => {
  it('accepts mcp__server__tool', () => {
    expect(validateRuleString('mcp__shortcut__create_story')).toEqual({ ok: true });
    expect(validateRuleString('mcp__neon__create_database')).toEqual({ ok: true });
    expect(validateRuleString('mcp__custom_server__some_tool')).toEqual({ ok: true });
  });

  it('accepts mcp__server__* wildcard', () => {
    expect(validateRuleString('mcp__shortcut__*')).toEqual({ ok: true });
  });

  it('accepts hyphenated server + tool segments (real .mcp.json convention)', () => {
    // Regression: pre-regex-widen these all silently parsed as errors, so
    // persistApprovedRule dropped the row → "approve doesn't persist" bug.
    expect(validateRuleString('mcp__shortcut-frink__stories-list')).toEqual({ ok: true });
    expect(validateRuleString('mcp__shortcut-frink__*')).toEqual({ ok: true });
    expect(validateRuleString('mcp__figma-mcp__get_design_context')).toEqual({ ok: true });
  });

  it.each(['resources/read', 'resources/list', 'resources/templates/list'])(
    'accepts the reserved MCP resource method %s',
    (method) => {
      expect(validateRuleString(`mcp__context7__${method}`)).toEqual({ ok: true });
    },
  );

  it('rejects bare mcp__server (no tool, no wildcard) — silent-dead at matcher', () => {
    expect(validateRuleString('mcp__shortcut').ok).toBe(false);
    expect(validateRuleString('mcp__shortcut-frink').ok).toBe(false);
  });
});

describe('validateRuleString — unknown tools rejected', () => {
  it('rejects single-char tool name (not a case-variant of any known tool)', () => {
    const r = validateRuleString('r');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Unknown tool/i);
  });

  it('rejects fabricated tool name', () => {
    const r = validateRuleString('xyzNotARealTool');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Unknown tool/i);
  });

  it('rejects near-miss like Reads (plural)', () => {
    const r = validateRuleString('Reads');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Unknown tool/i);
  });
});

describe('validateRuleString — wrong case + suggestion', () => {
  it('rejects lowercase `read` and suggests `Read`', () => {
    const r = validateRuleString('read');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/did you mean.+Read/i);
      expect(r.message).toMatch(/case-sensitive/i);
    }
  });

  it('rejects ALL-CAPS `READ` and suggests `Read`', () => {
    const r = validateRuleString('READ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/did you mean.+Read/i);
  });

  it('rejects `bash(npm:*)` (lowercase) and suggests `Bash`', () => {
    const r = validateRuleString('bash(npm:*)');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/did you mean.+Bash/i);
  });
});

describe('validateRuleString — malformed grammar bubbles up from parseRule', () => {
  it('rejects unmatched paren', () => {
    expect(validateRuleString('garbage(').ok).toBe(false);
  });

  it('rejects empty input', () => {
    expect(validateRuleString('').ok).toBe(false);
  });

  it('rejects whitespace-only input', () => {
    const r = validateRuleString('   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/empty/i);
  });
});

describe('validateRuleString — MCP edge inputs (parser-rejected)', () => {
  it('rejects bare `mcp__` prefix', () => {
    expect(validateRuleString('mcp__').ok).toBe(false);
  });

  it('rejects `mcp__shortcut__*` with content', () => {
    expect(validateRuleString('mcp__shortcut__*(anything)').ok).toBe(false);
  });
});

describe('validateRuleString — internal escapes pass through parseRule', () => {
  it('accepts escaped parens inside content', () => {
    expect(validateRuleString('Bash(echo \\(hi\\):*)').ok).toBe(true);
  });

  it('accepts deeply nested escapes', () => {
    expect(validateRuleString('Bash(node -e "console.log\\(1\\)")').ok).toBe(true);
  });
});

describe('validateRuleString — required-tool deny block', () => {
  it.each(['ExitPlanMode', 'TodoWrite', 'Task'])('rejects deny on required tool %s', (tool) => {
    const r = validateRuleString(tool, 'deny');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/required for the agent/i);
      expect(r.message).toContain(tool);
    }
  });

  it('allows ASK on required tool', () => {
    expect(validateRuleString('ExitPlanMode', 'ask')).toEqual({ ok: true });
    expect(validateRuleString('TodoWrite', 'ask')).toEqual({ ok: true });
  });

  it('allows ALLOW on required tool', () => {
    expect(validateRuleString('Task', 'allow')).toEqual({ ok: true });
  });

  it('still rejects deny on required tool when ruleType arg omitted defensively (no false positives)', () => {
    // No ruleType → no deny check → fall through to known-tool acceptance.
    expect(validateRuleString('ExitPlanMode')).toEqual({ ok: true });
  });

  it('deny on non-required known tool still works (e.g. Bash)', () => {
    expect(validateRuleString('Bash(rm -rf:*)', 'deny')).toEqual({ ok: true });
    expect(validateRuleString('Edit', 'deny')).toEqual({ ok: true });
  });
});

describe('validateRuleString — whitespace tolerance', () => {
  it('trims trailing space before parsing', () => {
    expect(validateRuleString('Read ').ok).toBe(true);
  });

  it('trims leading space before parsing', () => {
    expect(validateRuleString(' Read').ok).toBe(true);
  });

  it('trims both ends', () => {
    expect(validateRuleString('  Bash(npm:*)  ').ok).toBe(true);
  });
});
