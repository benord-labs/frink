import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { checkBash } from '../check-bash';
import fixture from './decisions-before.fixture.json';

/** Decisions the checker gave for this corpus before redirect targets were checked. */
const doc = z.object({
  allow: z.array(z.string()),
  deny: z.array(z.string()),
  ask: z.array(z.string()),
});
const corpus = z
  .object({
    projectRoot: z.string(),
    ruleSets: z.record(z.string(), z.object({ policy: doc, project: doc, user: doc })),
    commands: z.array(z.string()),
    decisions: z.record(z.string(), z.string()),
  })
  .parse(fixture);

const STRICTNESS = { a: 0, q: 1, d: 2 } as const;
const LETTER = { allow: 'a', ask: 'q', deny: 'd' } as const;

describe('redirect checking against the earlier decisions', () => {
  it('moves no command toward allow under any rule set', () => {
    const weaker: string[] = [];
    for (const [name, docs] of Object.entries(corpus.ruleSets)) {
      const before = corpus.decisions[name] ?? '';
      expect(before).toHaveLength(corpus.commands.length);
      corpus.commands.forEach((command, i) => {
        const now = LETTER[checkBash({ command }, docs, corpus.projectRoot).decision];
        const was = z.enum(['a', 'q', 'd']).parse(before[i]);
        if (STRICTNESS[now] < STRICTNESS[was])
          weaker.push(`${name}: ${command} (${was} -> ${now})`);
      });
    }
    expect(weaker).toEqual([]);
  });
});
