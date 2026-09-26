import { describe, expect, it } from 'vitest';
import { buildSdkAgentRecord, type FileAgent } from './agent-utils';

function agent(overrides: Partial<FileAgent> & Pick<FileAgent, 'name'>): FileAgent {
  return {
    description: '',
    prompt: '',
    source: 'user',
    path: `/home/.claude/agents/${overrides.name}.md`,
    ...overrides,
  };
}

describe('buildSdkAgentRecord (PCH-5 SDK fidelity)', () => {
  it('includes BOTH tools and disallowedTools — a restriction must never be dropped', () => {
    const record = buildSdkAgentRecord([
      agent({
        name: 'auditor',
        description: 'reads only',
        prompt: 'Audit.',
        tools: ['Read', 'Grep'],
        disallowedTools: ['Edit', 'Write'],
      }),
    ]);
    expect(record.auditor.tools).toEqual(['Read', 'Grep']);
    expect(record.auditor.disallowedTools).toEqual(['Edit', 'Write']);
  });

  it('omits restriction keys entirely when the agent declares none', () => {
    const record = buildSdkAgentRecord([
      agent({ name: 'free', description: 'unrestricted', prompt: 'Go.' }),
    ]);
    expect('tools' in record.free).toBe(false);
    expect('disallowedTools' in record.free).toBe(false);
  });
});
