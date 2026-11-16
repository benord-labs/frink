import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderTemplateForShell } from './template-utils';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

function executeQuotedPayload(
  template: string,
  valueForTarget: (target: string) => string,
): { output: string; target: string } {
  const directory = mkdtempSync(join(tmpdir(), 'frink-shell-template-'));
  temporaryDirectories.push(directory);
  const target = join(directory, 'injected');
  const command = renderTemplateForShell(template, {
    trigger: { value: valueForTarget(target) },
  });
  return { output: execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' }), target };
}

describe('renderTemplateForShell security', () => {
  it('keeps metacharacters inert inside an existing single-quoted argument', () => {
    const result = executeQuotedPayload(
      `printf '%s\n' '{{trigger.value}}'`,
      (target) => `payload; touch ${target}`,
    );
    expect(result.output).toContain('payload; touch');
    expect(existsSync(result.target)).toBe(false);
  });

  it('keeps command substitutions inert inside an existing double-quoted argument', () => {
    const result = executeQuotedPayload(
      `printf '%s\n' "{{trigger.value}}"`,
      (target) => `payload$(touch ${target})`,
    );
    expect(result.output).toContain('payload$(touch');
    expect(existsSync(result.target)).toBe(false);
  });

  it.each([
    [
      'inside a comment, broken out of by a newline',
      '# note: {{trigger.value}}\necho done',
      (target: string) => `x\ntouch ${target}\n`,
    ],
    [
      'after a comment holding a ) inside $( )',
      'out="$(\n# 1) fetch\necho "id={{trigger.value}}"\n)"\necho "$out"',
      (target: string) => `$(touch ${target})`,
    ],
    [
      'in quotes that follow a # inside a word',
      "echo `echo x`#'`echo y` {{trigger.value}}'",
      (target: string) => `$(touch ${target})`,
    ],
    [
      'in quotes after a backtick in a comment',
      "# x `\necho 'q `; echo {{trigger.value}}'",
      (target: string) => `$(touch ${target})`,
    ],
    [
      'right after a backslash',
      'echo \\{{trigger.value}}',
      (target: string) => `x\ntouch ${target}\n`,
    ],
    [
      'right after a backslash inside double quotes',
      'echo "\\{{trigger.value}}"',
      (target: string) => `$(touch ${target})`,
    ],
  ])('keeps a value inert when the placeholder sits %s', (_name, template, valueForTarget) => {
    const result = executeQuotedPayload(template, valueForTarget);
    expect(existsSync(result.target)).toBe(false);
  });

  it('leaves a placeholder right after $ literal, so the value cannot open an ANSI-C string', () => {
    const template = 'echo ${{trigger.value}}';
    expect(renderTemplateForShell(template, { trigger: { value: "a\\'; touch x; #" } })).toBe(
      template,
    );
  });

  it('leaves placeholders literal when nested shell syntax makes context uncertain', () => {
    expect(
      renderTemplateForShell(`echo "$(printf '{{trigger.value}}')"`, {
        trigger: { value: 'secret' },
      }),
    ).toBe(`echo "$(printf '{{trigger.value}}')"`);
  });

  it('renders a placeholder after a completed command substitution', () => {
    expect(
      renderTemplateForShell(`echo $(printf fixed) '{{trigger.value}}'`, {
        trigger: { value: 'resolved' },
      }),
    ).toBe(`echo $(printf fixed) 'resolved'`);
  });

  it('leaves a placeholder inside an unclosed command substitution literal', () => {
    const command = `echo "$(whoami {{trigger.value}} unfinished"`;
    expect(renderTemplateForShell(command, { trigger: { value: 'resolved' } })).toBe(command);
  });

  it('fails closed when a quoted expansion exceeds the output cap', () => {
    const largeValue = 'a'.repeat(50_000);
    const rendered = renderTemplateForShell(
      `printf '%s' "{{trigger.a}}{{trigger.b}}{{trigger.c}}{{trigger.d}}{{trigger.e}}{{trigger.f}}"`,
      {
        trigger: {
          a: largeValue,
          b: largeValue,
          c: largeValue,
          d: largeValue,
          e: largeValue,
          f: largeValue,
        },
      },
    );
    expect(rendered).toContain('rendered command exceeded');
    expect(() => execFileSync('/bin/sh', ['-c', rendered])).toThrow();
  });

  it('fails closed when an expansion consumes the closing quote budget', () => {
    const prefix = `printf '%s' "`;
    const totalValueLength = 256 * 1024 - prefix.length;
    const chunkLength = Math.floor(totalValueLength / 6);
    const trigger = Object.fromEntries(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((key, index) => [
        key,
        'a'.repeat(index === 5 ? totalValueLength - chunkLength * 5 : chunkLength),
      ]),
    );
    const rendered = renderTemplateForShell(
      `${prefix}{{trigger.a}}{{trigger.b}}{{trigger.c}}{{trigger.d}}{{trigger.e}}{{trigger.f}}"`,
      { trigger },
    );
    expect(rendered).toContain('rendered command exceeded');
    expect(() => execFileSync('/bin/sh', ['-c', rendered])).toThrow();
  });
});

const GENERATED_TOKENS = [
  '`',
  '#',
  "'",
  '"',
  '\\',
  '$(',
  ')',
  '(',
  "$'",
  '\n',
  ' ',
  '<<',
  ';',
  'echo ',
  'x',
  '$',
  '{{trigger.a}}',
];

/** Each prints PWN only if it runs as shell syntax: printing the text itself never spells it. */
const INJECTION_PAYLOADS = [
  'x\nprintf P%sN W\n',
  '$(printf P%sN W)`printf P%sN W`',
  "';printf P%sN W;'",
  '";printf P%sN W;"',
  "\\';printf P%sN W;'",
];

/** A seeded generator, so every run checks the same templates. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A short run of shell-significant tokens holding at least one placeholder. */
function generatedTemplate(next: () => number): string {
  let template = '';
  const length = 2 + Math.floor(next() * 14);
  for (let i = 0; i < length; i++) {
    template += GENERATED_TOKENS[Math.floor(next() * GENERATED_TOKENS.length)];
  }
  return template.includes('{{trigger.a}}') ? template : `${template} {{trigger.a}}`;
}

describe('renderTemplateForShell against a real shell', () => {
  it('never lets a value run as shell syntax in generated templates', () => {
    const next = seededRandom(20_261_025);
    const directory = mkdtempSync(join(tmpdir(), 'frink-shell-oracle-'));
    temporaryDirectories.push(directory);
    const injected: string[] = [];
    for (let n = 0; n < 150; n++) {
      const template = generatedTemplate(next);
      for (const value of INJECTION_PAYLOADS) {
        const command = renderTemplateForShell(template, { trigger: { a: value } });
        const result = spawnSync('/bin/sh', ['-c', command], {
          cwd: directory,
          input: '',
          encoding: 'utf8',
          timeout: 2_000,
        });
        if (`${result.stdout}${result.stderr}`.includes('PWN')) injected.push(template);
      }
    }
    expect(injected).toEqual([]);
  }, 60_000);
});
