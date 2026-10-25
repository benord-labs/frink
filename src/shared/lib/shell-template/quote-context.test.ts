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

describe('shellInterpolationContextAt — masked ranges and boundaries', () => {
  it.each([
    ['a # right after a masked backtick range', "`x`#'`y` {{a}}'", 'bare'],
    ['a # right after a masked ANSI-C string', "$'x'#'$'y' {{a}}'", 'bare'],
    ['a # right after two abutting masked ranges', "````#$'`` {{a}}", 'bare'],
    ['an escaped $( outside quotes', '\\$(x) {{a}}', 'bare'],
    ['an escaped $( inside double quotes', '"\\$(x) {{a}}"', 'double'],
    ['a placeholder ending the command inside an unclosed "', '"{{a}}', 'uncertain'],
    ['a trailing backslash after a placeholder inside "', '"{{a}}\\', 'uncertain'],
    ['a placeholder after an unquoted heredoc', 'cat <<EOF {{a}}', 'uncertain'],
    ['a placeholder ending where the heredoc cut starts', 'echo {{a}}<<X', 'bare'],
    ['a placeholder inside an unclosed $( after a quoted one', "'$(' $({{a}}", 'uncertain'],
  ])('classifies %s', (_name, command, expected) => {
    expect(shellInterpolationContextAt(command, command.indexOf('{{a}}'), '{{a}}'.length)).toBe(
      expected,
    );
  });

  it('gives the same answer when commands are classified in turn', () => {
    const quoted = "echo '{{a}}'";
    const bare = 'echo {{a}}';
    const classify = (command: string) =>
      shellInterpolationContextAt(command, command.indexOf('{{a}}'), '{{a}}'.length);
    expect([classify(quoted), classify(bare), classify(quoted), classify(quoted)]).toEqual([
      'single',
      'bare',
      'single',
      'single',
    ]);
  });
});

/** Fastest of three timings, each on a fresh command so no run reuses another's analysis. */
function fastestMs(run: (trial: number) => void): number {
  return Math.min(
    ...[0, 1, 2].map((trial) => {
      const started = performance.now();
      run(trial);
      return performance.now() - started;
    }),
  );
}

/** Classifies the first `limit` placeholders of `command`. */
function classifyPlaceholders(command: string, limit: number): void {
  for (const match of [...command.matchAll(/\{\{[^{}]+\}\}/g)].slice(0, limit)) {
    shellInterpolationContextAt(command, match.index, match[0].length);
  }
}

describe('shellInterpolationContextAt — cost stays linear in command length', () => {
  it.each([
    ['bare placeholders', (name: string) => `x {{t.${name}}}\n`.repeat(6_000)],
    [
      'placeholders in one unclosed double quote',
      (name: string) => `echo "${`x {{t.${name}}}\n`.repeat(6_000)}`,
    ],
    [
      'a substitution and a placeholder per line',
      (name: string) => `x=$(date) y={{t.${name}}}\n`.repeat(2_400),
    ],
  ])(
    'classifies every one of thousands of %s about as fast as the first',
    (_name, command) => {
      classifyPlaceholders(command('warm').slice(0, 2_000), Infinity);
      const one = fastestMs((trial) => classifyPlaceholders(command(`one${trial}`), 1));
      const all = fastestMs((trial) => classifyPlaceholders(command(`all${trial}`), Infinity));
      expect(all).toBeLessThan(one * 20);
    },
    30_000,
  );

  it('masks thousands of closed substitutions about as fast as plain text of the same length', () => {
    const command = (body: string, name: string) => `${body.repeat(6_000)}echo {{t.${name}}}`;
    classifyPlaceholders(command('x=$(date)\n', 'warm').slice(-2_000), Infinity);
    const plain = fastestMs((trial) => classifyPlaceholders(command('x=_date_\n', `p${trial}`), 1));
    const heavy = fastestMs((trial) =>
      classifyPlaceholders(command('x=$(date)\n', `h${trial}`), 1),
    );
    expect(heavy).toBeLessThan(plain * 20);
  }, 30_000);

  it('stops at an unclosed substitution instead of rescanning for every later one', () => {
    const command = (body: string, name: string) => `${body.repeat(20_000)}echo {{t.${name}}}`;
    classifyPlaceholders(command('$( ', 'warm').slice(-2_000), Infinity);
    const plain = fastestMs((trial) => classifyPlaceholders(command('x  ', `p${trial}`), 1));
    const unclosed = fastestMs((trial) => classifyPlaceholders(command('$( ', `u${trial}`), 1));
    expect(unclosed).toBeLessThan(plain * 20);
  }, 30_000);
});
