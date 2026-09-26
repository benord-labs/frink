/**
 * The runtime contract for a placeholder that does not resolve: ABSENT renders empty, UNRENDERABLE
 * keeps its literal. Shell-context escaping lives in template-utils-security.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  findAbsentPlaceholder,
  findAbsentShellPlaceholder,
  findUnsafeUrlPlaceholder,
  hasUnresolvedPlaceholder,
  renderTemplate,
  renderTemplateForShell,
  renderTemplateWithinUtf8Limit,
  resolveRoutingTemplate,
} from './template-utils';

/** Longer than MAX_OBJECT_SERIALIZE_LENGTH (50_000), so the renderer refuses to expand it. */
const OVERSIZE = 'x'.repeat(50_001);

/** A self-referencing node — JSON.stringify throws on it, so the renderer cannot expand it. */
type SelfReferencing = { self: SelfReferencing | null };

function circular(): SelfReferencing {
  const node: SelfReferencing = { self: null };
  node.self = node;
  return node;
}

describe('renderTemplate — absent paths', () => {
  it('renders an absent key as empty rather than its own placeholder text', () => {
    const out = renderTemplate('working in {{previous.worktreePath}}.', { previous: {} });
    expect(out).toBe('working in .');
    expect(out).not.toContain('{{previous.');
  });

  it('renders an absent key as empty even when the predecessor produced other outputs', () => {
    // A `guaranteed: false` output (output-schemas.ts) is legitimately missing on a normal run,
    // so this must stay a render, not an error.
    const out = renderTemplate('{{previous.summary}}|{{previous.exitCode}}', {
      previous: { exitCode: 0 },
    });
    expect(out).toBe('|0');
  });

  it('renders absent paths as empty for every template root', () => {
    const out = renderTemplate(
      '[{{trigger.nope}}][{{previous.nope}}][{{loop.nope}}][{{flow.nope}}]',
      { trigger: {}, previous: {}, loop: {}, flow: {} },
    );
    expect(out).toBe('[][][][]');
  });

  it('renders a disallowed root as empty, so a mistyped scope cannot reach a consumer', () => {
    expect(renderTemplate('a{{env.HOME}}b', {})).toBe('ab');
  });

  it('renders a blocked prototype-pollution segment as empty', () => {
    expect(renderTemplate('a{{previous.__proto__}}b', { previous: {} })).toBe('ab');
  });

  it('distinguishes a present null from an absent key — both empty, neither literal', () => {
    expect(renderTemplate('[{{previous.a}}][{{previous.b}}]', { previous: { a: null } })).toBe(
      '[][]',
    );
  });

  it('applies the same rule to renderTemplateWithinUtf8Limit', () => {
    expect(renderTemplateWithinUtf8Limit('x{{previous.nope}}y', { previous: {} }, 1024)).toBe('xy');
  });
});

describe('renderTemplate — values that cannot be rendered as text', () => {
  it('keeps the literal placeholder for an oversize string leaf', () => {
    expect(renderTemplate('a{{previous.big}}b', { previous: { big: OVERSIZE } })).toBe(
      'a{{previous.big}}b',
    );
  });

  it('keeps the literal placeholder for an oversize object leaf', () => {
    expect(renderTemplate('a{{previous.big}}b', { previous: { big: { v: OVERSIZE } } })).toBe(
      'a{{previous.big}}b',
    );
  });

  it('keeps the literal placeholder for a circular object leaf', () => {
    expect(renderTemplate('a{{previous.c}}b', { previous: { c: circular() } })).toBe(
      'a{{previous.c}}b',
    );
  });

  it('keeps the literal placeholder for a bigint leaf', () => {
    expect(renderTemplate('a{{previous.n}}b', { previous: { n: 1n } })).toBe('a{{previous.n}}b');
  });

  it('still expands an object leaf under the cap as JSON', () => {
    expect(renderTemplate('{{previous.v}}', { previous: { v: { ok: true } } })).toBe('{"ok":true}');
  });
});

describe('renderTemplateForShell — absent vs unrenderable', () => {
  it('escapes an absent path as an empty argument, never as literal placeholder text', () => {
    const out = renderTemplateForShell('echo {{previous.nope}}', { previous: {} });
    expect(out).toBe("echo ''");
    expect(out).not.toContain('{{previous.');
  });

  it('keeps the literal placeholder for an unrenderable value', () => {
    expect(renderTemplateForShell('echo {{previous.c}}', { previous: { c: circular() } })).toBe(
      'echo {{previous.c}}',
    );
  });

  it('keeps even an ABSENT path literal where the shell context is uncertain', () => {
    // The one documented exception to empty-on-absent: flow-command-interpolation-safety draws its
    // boundary on the context, so nothing is substituted there. run_command only; not agent prompts.
    expect(
      renderTemplateForShell(`echo "$(printf '{{previous.nope}}')"`, { previous: {} }),
    ).toContain('{{previous.nope}}');
  });

  it('leaves a resolvable placeholder literal when the shell quote context is uncertain', () => {
    // Independent of the absent-path rule above: docs/decisions/flow-command-interpolation-safety
    // requires an uncertain context to stay literal even though the value resolves fine.
    expect(
      renderTemplateForShell(`echo "$(printf '{{trigger.value}}')"`, {
        trigger: { value: 'resolves-fine' },
      }),
    ).toContain('{{trigger.value}}');
  });
});

describe('hasUnresolvedPlaceholder', () => {
  it('is true for an absent path, so routing fields can fail closed', () => {
    expect(hasUnresolvedPlaceholder('{{previous.branch}}', { previous: {} })).toBe(true);
  });

  it('is true for an unrenderable value', () => {
    expect(hasUnresolvedPlaceholder('{{previous.c}}', { previous: { c: circular() } })).toBe(true);
  });

  it('is false when every placeholder resolves, including to an empty string', () => {
    expect(
      hasUnresolvedPlaceholder('{{previous.a}}{{previous.b}}', { previous: { a: '', b: 0 } }),
    ).toBe(false);
  });

  it('sees through path canonicalisation, which the rendered output cannot', () => {
    expect(hasUnresolvedPlaceholder('{{ previous.nope }}', { previous: {} })).toBe(true);
  });
});

describe('resolveRoutingTemplate', () => {
  it('returns the rendered value when every placeholder resolves', () => {
    expect(
      resolveRoutingTemplate('feat/{{previous.ticket}}', { previous: { ticket: 'sc-2706' } }),
    ).toEqual({ ok: true, value: 'feat/sc-2706' });
  });

  it('rejects a partly-resolved template, which renders NON-empty and would name a real branch', () => {
    expect(resolveRoutingTemplate('feat/{{previous.ticket}}', { previous: {} })).toEqual({
      ok: false,
      reason: 'did not resolve',
    });
  });

  it('rejects a resolved-but-blank value, which passes the placeholder check', () => {
    expect(resolveRoutingTemplate('{{previous.branch}}', { previous: { branch: '' } })).toEqual({
      ok: false,
      reason: 'resolved to nothing',
    });
  });

  it('rejects a whitespace-only result for the same reason as a blank one', () => {
    expect(
      resolveRoutingTemplate('  {{previous.branch}}  ', { previous: { branch: '   ' } }),
    ).toEqual({ ok: false, reason: 'resolved to nothing' });
  });

  it('rejects an unrenderable value rather than routing on its literal placeholder', () => {
    expect(resolveRoutingTemplate('{{previous.big}}', { previous: { big: circular() } })).toEqual({
      ok: false,
      reason: 'did not resolve',
    });
  });

  it('rejects an unclosed placeholder, which matches no token and would route on its own text', () => {
    expect(resolveRoutingTemplate('{{previous.branch', { previous: { branch: 'b' } })).toEqual({
      ok: false,
      reason: 'is malformed',
    });
  });

  it('rejects a stray closing double-brace beside a well-formed placeholder', () => {
    expect(resolveRoutingTemplate('feat/{{previous.t}}}}', { previous: { t: 'x' } })).toEqual({
      ok: false,
      reason: 'is malformed',
    });
  });

  it('rejects Handlebars-style triple braces rather than routing on the braces around the value', () => {
    // `{{{x}}}` is the unescaped-output habit from Handlebars/Mustache; it would yield branch `{main}`.
    expect(
      resolveRoutingTemplate('{{{previous.branch}}}', { previous: { branch: 'main' } }),
    ).toEqual({
      ok: false,
      reason: 'is malformed',
    });
  });

  it('accepts single braces, which are legal in a branch or project name', () => {
    expect(resolveRoutingTemplate('release/{candidate}', {})).toEqual({
      ok: true,
      value: 'release/{candidate}',
    });
  });

  it('rejects an over-long template, which rendering would truncate into a different valid value', () => {
    const long = `feat/${'a'.repeat(600)}`;
    expect(resolveRoutingTemplate(long, {})).toEqual({ ok: false, reason: 'is too long' });
  });

  it('accepts a static value with no placeholders', () => {
    expect(resolveRoutingTemplate('main', {})).toEqual({ ok: true, value: 'main' });
  });
});

describe('executable-sink placeholder checks', () => {
  it('treat a non-string template from unchecked graph JSON as placeholder-free, never throwing', () => {
    const persisted: string = JSON.parse('123');
    expect(findAbsentPlaceholder(persisted, {})).toBeUndefined();
    expect(findUnsafeUrlPlaceholder(persisted, {})).toBeUndefined();
  });

  it('findAbsentPlaceholder flags a missing path but not a value too large to render', () => {
    expect(findAbsentPlaceholder('rm -rf /tmp/{{previous.dir}}', { previous: {} })).toBe(
      '{{previous.dir}}',
    );
    expect(
      findAbsentPlaceholder('echo {{previous.c}}', { previous: { c: circular() } }),
    ).toBeUndefined();
  });

  it('findUnsafeUrlPlaceholder flags a blank value in the path but allows one in the query', () => {
    const vars = { previous: { id: '', q: '' } };
    expect(findUnsafeUrlPlaceholder('https://api.test/items/{{previous.id}}', vars)).toBe(
      '{{previous.id}}',
    );
    expect(
      findUnsafeUrlPlaceholder('https://api.test/items?q={{previous.q}}', vars),
    ).toBeUndefined();
  });

  it('findUnsafeUrlPlaceholder flags a missing value even in the query', () => {
    expect(
      findUnsafeUrlPlaceholder('https://api.test/items?q={{previous.q}}', { previous: {} }),
    ).toBe('{{previous.q}}');
  });
});

describe('findAbsentShellPlaceholder', () => {
  it('flags a missing value in a bare shell position', () => {
    expect(findAbsentShellPlaceholder('rm -rf /tmp/work/{{previous.dir}}', { previous: {} })).toBe(
      '{{previous.dir}}',
    );
  });

  it('skips a missing value in an uncertain shell context, where it stays literal and is never run', () => {
    // flow-command-interpolation-safety never substitutes there, so nothing can collapse.
    expect(
      findAbsentShellPlaceholder(`echo "$(printf '{{previous.missing}}')"`, { previous: {} }),
    ).toBeUndefined();
  });
});

describe('findUnsafeUrlPlaceholder path boundary', () => {
  it('finds the query boundary in literal text only, never inside a placeholder path', () => {
    // A webhook key can contain ? or #, so {{trigger.id?variant}} still sits in the path here.
    expect(
      findUnsafeUrlPlaceholder('https://api.test/items/{{trigger.id?variant}}', {
        trigger: { 'id?variant': '' },
      }),
    ).toBe('{{trigger.id?variant}}');
  });
});
