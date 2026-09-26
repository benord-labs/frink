import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';
import { updateAgentMd } from './agent-utils';

const EXISTING = `---
name: auditor
description: old description
tools: Read, Grep
model: opus
color: red
readonly: true
---

Old body.
`;

const baseEdit = { name: 'auditor', description: 'new description', prompt: 'New body.' };

describe('updateAgentMd (sc-861 — frontmatter fidelity on UI edit)', () => {
  it('preserves unknown frontmatter keys across an edit', () => {
    const out = matter(updateAgentMd(EXISTING, baseEdit));
    expect(out.data.color).toBe('red');
    expect(out.data.readonly).toBe(true);
    expect(out.data.description).toBe('new description');
    expect(out.content.trim()).toBe('New body.');
  });

  it('undefined typed fields PRESERVE existing values (partial-update caller safety)', () => {
    const out = matter(updateAgentMd(EXISTING, baseEdit)); // no tools/model passed
    expect(out.data.tools).toBe('Read, Grep'); // untouched, original form kept
    expect(out.data.model).toBe('opus');
  });

  it('an explicit empty array CLEARS tools; "inherit" clears model (no stale keys)', () => {
    const out = matter(updateAgentMd(EXISTING, { ...baseEdit, tools: [], model: 'inherit' }));
    expect('tools' in out.data).toBe(false);
    expect('model' in out.data).toBe(false);
    expect(out.data.color).toBe('red'); // unknown keys still intact
  });

  it('explicit new values overlay the old ones', () => {
    const out = matter(
      updateAgentMd(EXISTING, { ...baseEdit, tools: ['Read'], disallowedTools: ['Edit'] }),
    );
    expect(out.data.tools).toEqual(['Read']);
    expect(out.data.disallowedTools).toEqual(['Edit']);
  });

  it('a multiline quoted description survives parse-equivalently', () => {
    const src = matter.stringify('Body.\n', {
      name: 'multi',
      description: 'Line one: colon\n"Quoted" line two',
      custom: 'kept',
    });
    const out = matter(
      updateAgentMd(src, {
        name: 'multi',
        description: 'Line one: colon\n"Quoted" line two',
        prompt: 'Body.',
      }),
    );
    expect(out.data.description).toBe('Line one: colon\n"Quoted" line two');
    expect(out.data.custom).toBe('kept');
  });
});
