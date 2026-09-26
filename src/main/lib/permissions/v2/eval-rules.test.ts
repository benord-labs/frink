import { describe, expect, it } from 'vitest';
import { combineScopes, evalScope, resultFromCombined, type ScopeEval } from './eval-rules';
import type { PermissionsDoc } from './types';

const empty: PermissionsDoc = { allow: [], deny: [], ask: [] };
const miss: ScopeEval = { kind: 'miss' };

describe('evalScope — per-rule precedence (deny > ask > allow)', () => {
  it('deny matches first', () => {
    const doc: PermissionsDoc = {
      deny: ['Bash(rm:*)'],
      ask: ['Bash(rm:*)'],
      allow: ['Bash(rm:*)'],
    };
    expect(
      evalScope(doc, 'Bash', {}, { bashCommandSignature: { base: 'rm', fullSignature: 'rm' } }),
    ).toEqual({
      kind: 'deny',
      rule: 'Bash(rm:*)',
    });
  });

  it('ask matches when no deny', () => {
    const doc: PermissionsDoc = {
      deny: [],
      ask: ['Bash(rm:*)'],
      allow: ['Bash(rm:*)'],
    };
    expect(
      evalScope(doc, 'Bash', {}, { bashCommandSignature: { base: 'rm', fullSignature: 'rm' } }),
    ).toEqual({
      kind: 'ask',
      rule: 'Bash(rm:*)',
    });
  });

  it('allow matches when no deny or ask', () => {
    const doc: PermissionsDoc = { deny: [], ask: [], allow: ['Bash(rm:*)'] };
    expect(
      evalScope(doc, 'Bash', {}, { bashCommandSignature: { base: 'rm', fullSignature: 'rm' } }),
    ).toEqual({
      kind: 'allow',
      rule: 'Bash(rm:*)',
    });
  });

  it('miss when nothing matches', () => {
    expect(evalScope(empty, 'Bash', {})).toEqual({ kind: 'miss' });
  });

  it('handles undefined deny/ask/allow arrays', () => {
    expect(evalScope({} as PermissionsDoc, 'Bash', {})).toEqual({ kind: 'miss' });
  });
});

describe('combineScopes — truth table', () => {
  const denyR: ScopeEval = { kind: 'deny', rule: 'X' };
  const askR: ScopeEval = { kind: 'ask', rule: 'X' };
  const allowR: ScopeEval = { kind: 'allow', rule: 'X' };

  it('policy deny wins', () => {
    expect(combineScopes(denyR, allowR, allowR)).toEqual({
      decision: 'deny',
      tier: 'policy',
      rule: 'X',
    });
  });

  it('project deny wins (no policy deny)', () => {
    expect(combineScopes(allowR, denyR, allowR)).toMatchObject({
      decision: 'deny',
      tier: 'project',
    });
  });

  it('user deny wins (no policy/project deny)', () => {
    expect(combineScopes(allowR, allowR, denyR)).toMatchObject({ decision: 'deny', tier: 'user' });
  });

  it('policy ask beats project allow + user allow', () => {
    expect(combineScopes(askR, allowR, allowR)).toMatchObject({ decision: 'ask', tier: 'policy' });
  });

  it('miss policy + project ask → ask (project)', () => {
    expect(combineScopes(miss, askR, allowR)).toMatchObject({ decision: 'ask', tier: 'project' });
  });

  it('miss policy + miss project + user ask → ask (user)', () => {
    expect(combineScopes(miss, miss, askR)).toMatchObject({ decision: 'ask', tier: 'user' });
  });

  it('project allow beats user ask (precedence)', () => {
    expect(combineScopes(miss, allowR, askR)).toMatchObject({ decision: 'allow', tier: 'project' });
  });

  it('miss policy + miss project + user allow → allow (user)', () => {
    expect(combineScopes(miss, miss, allowR)).toMatchObject({ decision: 'allow', tier: 'user' });
  });

  it('all miss → ask (default prompt)', () => {
    expect(combineScopes(miss, miss, miss)).toEqual({ decision: 'ask' });
  });
});

describe('resultFromCombined', () => {
  it('deny → PermissionResult deny with rule:deny reason', () => {
    expect(
      resultFromCombined({ decision: 'deny', tier: 'project', rule: 'Bash(rm:*)' }, 'Bash', {
        command: 'rm foo',
      }),
    ).toEqual({
      decision: 'deny',
      reason: { kind: 'rule:deny', rule: 'Bash(rm:*)', tier: 'project' },
    });
  });

  it('allow → bare allow', () => {
    expect(resultFromCombined({ decision: 'allow' }, 'Bash', {})).toEqual({ decision: 'allow' });
  });

  it('ask with rule → reason rule:ask + matchedRule + matchedTier', () => {
    const r = resultFromCombined({ decision: 'ask', tier: 'user', rule: 'Bash(rm:*)' }, 'Bash', {
      command: 'rm foo',
    });
    expect(r).toMatchObject({
      decision: 'ask',
      prompt: { reason: 'rule:ask', matchedRule: 'Bash(rm:*)', matchedTier: 'user', tool: 'Bash' },
    });
  });

  it('ask without rule (all miss) → reason no-matching-rule', () => {
    const r = resultFromCombined({ decision: 'ask' }, 'Bash', { command: 'foo' });
    expect(r).toMatchObject({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule', tool: 'Bash', input: { command: 'foo' } },
    });
  });

  it('throws on deny without rule (invariant violation)', () => {
    expect(() => resultFromCombined({ decision: 'deny' }, 'Bash', {})).toThrow();
  });
});
