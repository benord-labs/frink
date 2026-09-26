import { describe, expect, it } from 'vitest';
import type { FlowGraph } from '../validate-flow-graph';
import { validateFlowTemplateVariables } from '../validate-flow-templates';
import { shellInterpolationContextAt } from './quote-context';

function warningsFor(command: string) {
  const graph: FlowGraph = {
    nodes: [
      { id: 't', blockType: 'manual_trigger' },
      { id: 'r', blockType: 'run_command', config: { command, projectId: 'p1' } },
    ],
    edges: [{ id: 'e', source: 't', target: 'r' }],
  };
  return validateFlowTemplateVariables(graph).filter((warning) => warning.field === 'command');
}

describe('run_command quoted template warnings', () => {
  it.each([
    ['single', "echo 'LOW — {{trigger.summary}}'"],
    ['double', 'echo "LOW — {{trigger.summary}}"'],
  ])('warns for a placeholder inside %s quotes', (quoteKind, command) => {
    expect(warningsFor(command)).toContainEqual(
      expect.objectContaining({
        nodeId: 'r',
        placeholder: '{{trigger.summary}}',
        message: expect.stringMatching(new RegExp(`${quoteKind}.*context-escapes`, 'i')),
      }),
    );
  });

  it('does not warn for a bare placeholder or escaped quote literals', () => {
    expect(warningsFor('echo LOW {{trigger.summary}}')).toEqual([]);
    expect(warningsFor('echo \\"{{trigger.summary}}\\"')).toEqual([]);
  });

  it('reports a placeholder after an unclosed quote as uncertain, matching the runtime', () => {
    expect(warningsFor("echo Don't worry, {{trigger.summary}} looks fine")).toEqual([
      expect.objectContaining({ shellQuoteContext: 'uncertain' }),
    ]);
  });

  it('treats backslashes as literal inside single quotes', () => {
    expect(warningsFor(String.raw`echo '\'{{trigger.summary}}`)).toEqual([]);
    expect(warningsFor(String.raw`echo '\''{{trigger.summary}}'`)).toHaveLength(1);
  });

  it('skips Bash ANSI-C strings without leaking their quote state', () => {
    expect(warningsFor(String.raw`echo $'a\'b' {{trigger.summary}}`)).toEqual([]);
    expect(warningsFor(`echo "price $'5" '{{trigger.summary}}'`)[0]?.shellQuoteContext).toBe(
      'single',
    );
  });

  it('ignores comments and resumes analysis on the next line', () => {
    expect(warningsFor('# "{{trigger.summary}}"\necho {{trigger.summary}}')).toEqual([]);
    expect(warningsFor('echo "value#{{trigger.summary}}"')).toHaveLength(1);
  });

  it('classifies nested command substitutions without losing the outer quote state', () => {
    const warnings = warningsFor(
      "echo \"$(printf '%s' '{{trigger.inside}}') {{trigger.outside}}\"",
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({
        placeholder: '{{trigger.inside}}',
        shellQuoteContext: 'uncertain',
      }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({ placeholder: '{{trigger.outside}}', shellQuoteContext: 'double' }),
    );
    expect(warningsFor('echo "$(echo "(hi)")" {{trigger.summary}}')).toEqual([]);
  });

  it('warns that an uncertain placeholder will not be substituted', () => {
    const warnings = warningsFor('echo $(basename {{trigger.summary}})');
    expect(warnings).toEqual([
      expect.objectContaining({
        placeholder: '{{trigger.summary}}',
        shellQuoteContext: 'uncertain',
        message: expect.stringContaining('will NOT be substituted'),
      }),
    ]);
  });

  it('keeps backticks literal inside POSIX single quotes', () => {
    expect(warningsFor("echo 'Build `{{trigger.summary}}` failed'")).toHaveLength(1);
  });

  it('reports placeholders after heredocs and in unclosed command substitutions as uncertain', () => {
    expect(warningsFor('cat <<EOF\n"{{trigger.summary}}"\nEOF')).toEqual([
      expect.objectContaining({ shellQuoteContext: 'uncertain' }),
    ]);
    expect(warningsFor('echo "$(printf {{trigger.summary}}"')).toEqual([
      expect.objectContaining({ shellQuoteContext: 'uncertain' }),
    ]);
  });

  it('does not mistake shell-like text inside quotes for uncertain syntax', () => {
    expect(warningsFor('echo "retry count is <<{{trigger.summary}}>>"')).toHaveLength(1);
  });

  it('deduplicates repeated placeholders in the same quote context', () => {
    expect(warningsFor("echo '{{trigger.summary}} {{trigger.summary}}'")).toHaveLength(1);
  });
});

describe('shellInterpolationContextAt', () => {
  it('classifies a quote after a completed command substitution', () => {
    const command = `echo $(printf fixed) '{{trigger.summary}}'`;
    const offset = command.indexOf('{{');
    expect(shellInterpolationContextAt(command, offset, '{{trigger.summary}}'.length)).toBe(
      'single',
    );
  });

  it('keeps a placeholder inside a command substitution uncertain', () => {
    const command = `echo "$(printf '{{trigger.summary}}')"`;
    const offset = command.indexOf('{{');
    expect(shellInterpolationContextAt(command, offset, '{{trigger.summary}}'.length)).toBe(
      'uncertain',
    );
  });

  it('keeps an unclosed command substitution inside double quotes uncertain', () => {
    const command = `echo "$(whoami {{trigger.summary}} unfinished"`;
    const offset = command.indexOf('{{');
    expect(shellInterpolationContextAt(command, offset, '{{trigger.summary}}'.length)).toBe(
      'uncertain',
    );
  });
});
