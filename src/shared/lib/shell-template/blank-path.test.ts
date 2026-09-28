import { describe, expect, it } from 'vitest';
import type { FlowGraph, FlowNode } from '../validate-flow-graph';
import { validateFlowTemplateVariables } from '../validate-flow-templates';
import { findBlankPathShellTemplateWarnings } from './blank-path';

// sc-3170: a present-but-blank value still renders, so `rm -rf /tmp/work/{{x}}` runs as
// `rm -rf /tmp/work/`. The runtime deliberately allows it; the design-time warning is the signal.
function graphWith(node: FlowNode): FlowGraph {
  return {
    nodes: [{ id: 't', blockType: 'manual_trigger' }, node],
    edges: [{ id: 'e', source: 't', target: node.id }],
  };
}

function blankPathWarningsFor(command: string) {
  return validateFlowTemplateVariables(
    graphWith({ id: 'r', blockType: 'run_command', config: { command, projectId: 'p1' } }),
  ).filter((warning) => warning.shellHazard === 'blank-path');
}

describe('run_command blank-path template warnings', () => {
  it('warns for the story command, naming the placeholder and the ${v:?} guard', () => {
    expect(blankPathWarningsFor('rm -rf /tmp/work/{{previous.dir}}')).toEqual([
      {
        nodeId: 'r',
        field: 'command',
        placeholder: '{{previous.dir}}',
        shellHazard: 'blank-path',
        message: expect.stringMatching(/\{\{previous\.dir\}\}.*\$\{v:\?\}/s),
      },
    ]);
  });

  it.each([
    ['a leading placeholder that collapses to the root', 'rm -rf {{trigger.dir}}/'],
    ['a middle path segment', 'rm -rf /srv/{{trigger.dir}}/cache'],
    ['a home-relative path', 'rm -rf ~/{{trigger.dir}}'],
    ['an env-var prefix', 'rm -rf $HOME/{{trigger.dir}}'],
    ['a double-quoted path, which is still substituted', 'rm -rf "/tmp/{{trigger.dir}}"'],
    ['a single-quoted path, which is still substituted', "rm -rf '/tmp/{{trigger.dir}}'"],
    ['a URL path segment in a curl command', 'curl -X DELETE https://api/items/{{trigger.dir}}'],
    ['a placeholder at the very end of the command', 'ls /{{trigger.dir}}'],
    ['a placeholder at the very start of the command', '{{trigger.dir}}/run.sh'],
  ])('warns for %s', (_label, command) => {
    expect(blankPathWarningsFor(command)).toHaveLength(1);
  });

  it.each([
    ['an echo-style blank argument', 'echo {{trigger.note}}'],
    ['a quoted prose value', 'echo "note: {{trigger.note}}"'],
    ['the guarded assignment the warning recommends', 'v={{trigger.dir}}; rm -rf "/tmp/${v:?}"'],
    ['a flag value separated by a space', 'git log --author {{trigger.author}} -- src/'],
    ['a placeholder that is the whole command', '{{trigger.cmd}}'],
    ['a value joined by a non-separator character', 'cp a.txt b-{{trigger.suffix}}.txt'],
  ])('does not warn for %s', (_label, command) => {
    expect(blankPathWarningsFor(command)).toEqual([]);
  });

  it.each([
    ['command substitution', 'x=$(ls /tmp/{{trigger.dir}})'],
    ['backticks', 'x=`ls /tmp/{{trigger.dir}}`'],
    ['a heredoc body', 'cat <<EOF\n/tmp/{{trigger.dir}}\nEOF'],
  ])('skips a placeholder inside %s, which the runtime never substitutes', (_label, command) => {
    expect(blankPathWarningsFor(command)).toEqual([]);
    // It still gets the existing "will not be substituted" advisory instead.
    const all = validateFlowTemplateVariables(
      graphWith({ id: 'r', blockType: 'run_command', config: { command, projectId: 'p1' } }),
    );
    expect(all).toContainEqual(expect.objectContaining({ shellQuoteContext: 'uncertain' }));
  });

  it('reports a quoted path placeholder under both hazards, as separate warnings', () => {
    const all = validateFlowTemplateVariables(
      graphWith({
        id: 'r',
        blockType: 'run_command',
        config: { command: 'rm -rf "/tmp/{{trigger.dir}}"', projectId: 'p1' },
      }),
    );
    expect(all).toContainEqual(expect.objectContaining({ shellQuoteContext: 'double' }));
    expect(all).toContainEqual(expect.objectContaining({ shellHazard: 'blank-path' }));
  });

  it('deduplicates a repeated placeholder, including whitespace-padded spellings', () => {
    expect(
      blankPathWarningsFor('mkdir -p /a/{{trigger.dir}} && cp x /b/{{ trigger.dir }}/'),
    ).toEqual([expect.objectContaining({ placeholder: '{{trigger.dir}}' })]);
  });

  it('warns once per distinct placeholder in the same command', () => {
    const placeholders = blankPathWarningsFor('mv /src/{{trigger.a}} /dst/{{trigger.b}}').map(
      (w) => w.placeholder,
    );
    expect(placeholders).toEqual(['{{trigger.a}}', '{{trigger.b}}']);
  });

  it('only inspects run_command commands', () => {
    const nodes: FlowNode[] = [
      { id: 's', blockType: 'start_task', config: { label: 'fix /tmp/{{trigger.dir}}' } },
      { id: 'a', blockType: 'agent', config: { instructions: 'Clean /tmp/{{trigger.dir}}' } },
      { id: 'r', blockType: 'run_command', config: { customPath: '/tmp/{{trigger.dir}}' } },
    ];
    expect(findBlankPathShellTemplateWarnings(nodes)).toEqual([]);
  });

  it('ignores an empty placeholder body', () => {
    expect(
      findBlankPathShellTemplateWarnings([
        { id: 'r', blockType: 'run_command', config: { command: 'rm -rf /tmp/{{ }}' } },
      ]),
    ).toEqual([]);
  });
});
