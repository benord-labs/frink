import { execFileSync } from 'node:child_process';
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
