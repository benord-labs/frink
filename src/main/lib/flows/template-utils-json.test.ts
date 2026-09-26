import { describe, expect, it } from 'vitest';
import { renderTemplateDeep, renderTemplateForJson } from './template-utils';

const variables = {
  previous: {
    text: 'say "hi"\nnow',
    count: 3,
    on: true,
    nothing: null,
    filters: { from: '-7d', tags: ['a', 'b'] },
  },
};

describe('renderTemplateForJson', () => {
  it('escapes a placeholder inside a string literal so the document still parses', () => {
    const rendered = renderTemplateForJson('{"label": "{{previous.text}}"}', variables);
    expect(JSON.parse(rendered)).toEqual({ label: 'say "hi"\nnow' });
  });

  it('splices a placeholder outside a string literal as a typed JSON value', () => {
    const rendered = renderTemplateForJson(
      '{"s": {{previous.text}}, "n": {{previous.count}}, "b": {{previous.on}}, "z": {{previous.nothing}}, "o": {{previous.filters}}}',
      variables,
    );
    expect(JSON.parse(rendered)).toEqual({
      s: 'say "hi"\nnow',
      n: 3,
      b: true,
      z: null,
      o: { from: '-7d', tags: ['a', 'b'] },
    });
  });

  it('renders an object as escaped text when it sits inside a string literal', () => {
    const rendered = renderTemplateForJson('{"raw": "{{previous.filters}}"}', variables);
    expect(JSON.parse(rendered)).toEqual({ raw: JSON.stringify(variables.previous.filters) });
  });

  it('renders an absent placeholder inside a string literal as the empty string', () => {
    // Inside quotes the literal would still parse, silently handing the tool placeholder text.
    const rendered = renderTemplateForJson('{"label": "a{{previous.missing}}b"}', variables);
    expect(JSON.parse(rendered)).toEqual({ label: 'ab' });
  });

  it('keeps an absent placeholder literal outside a string literal, so the parse fails loudly', () => {
    expect(renderTemplateForJson('{"x": {{previous.missing}}}', variables)).toBe(
      '{"x": {{previous.missing}}}',
    );
  });

  it('tracks string parity across escaped quotes', () => {
    const rendered = renderTemplateForJson(
      '{"quoted": "a \\" b", "n": {{previous.count}}, "t": "{{previous.text}}"}',
      variables,
    );
    expect(JSON.parse(rendered)).toEqual({ quoted: 'a " b', n: 3, t: 'say "hi"\nnow' });
  });
});

describe('renderTemplateDeep', () => {
  it('renders every string leaf of a structure; a whole placeholder keeps the value type', () => {
    expect(
      renderTemplateDeep(
        {
          n: '{{previous.count}}',
          o: '{{previous.filters}}',
          s: 'count={{previous.count}}',
          list: ['{{previous.on}}', { deep: '{{previous.nothing}}' }],
          plain: 7,
        },
        variables,
      ),
    ).toEqual({
      n: 3,
      o: { from: '-7d', tags: ['a', 'b'] },
      s: 'count=3',
      list: [true, { deep: null }],
      plain: 7,
    });
  });

  it('never truncates a leaf: long text passes byte-identical, with or without a placeholder', () => {
    const long = 'x'.repeat(12_000);
    const withPlaceholder = `${long}{{previous.count}}`;
    expect(renderTemplateDeep({ a: long, b: withPlaceholder }, variables)).toEqual({
      a: long,
      b: withPlaceholder,
    });
  });

  it('keeps the literal for a whole placeholder whose value is too large to render', () => {
    const oversize = { previous: { big: 'x'.repeat(50_001) } };
    expect(renderTemplateDeep({ x: '{{previous.big}}' }, oversize)).toEqual({
      x: '{{previous.big}}',
    });
  });

  it('gives an absent whole placeholder the value a present null would, never its literal text', () => {
    // A structure leaf has no parse step to fail, so a literal would reach the tool as data.
    expect(renderTemplateDeep({ x: '{{previous.missing}}' }, variables)).toEqual({ x: null });
  });
});
