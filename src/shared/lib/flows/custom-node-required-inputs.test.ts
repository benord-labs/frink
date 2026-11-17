import { describe, expect, it } from 'vitest';
import {
  findMissingRequiredCustomNodeInputs,
  isTemplateRenderedInput,
  parseManifestInputDeclarations,
} from './custom-node-required-inputs';

describe('findMissingRequiredCustomNodeInputs', () => {
  it('reports nothing for a node that declares no inputs', () => {
    expect(findMissingRequiredCustomNodeInputs({}, {})).toEqual([]);
    expect(findMissingRequiredCustomNodeInputs(undefined, {})).toEqual([]);
  });

  it('reports a required input with no saved value and no default', () => {
    expect(
      findMissingRequiredCustomNodeInputs({ repo: { type: 'string', required: true } }, {}),
    ).toEqual(['repo']);
  });

  it('treats a blank or whitespace-only value as no value', () => {
    const inputs = { repo: { type: 'string', required: true } };
    expect(findMissingRequiredCustomNodeInputs(inputs, { repo: '' })).toEqual(['repo']);
    expect(findMissingRequiredCustomNodeInputs(inputs, { repo: '   ' })).toEqual(['repo']);
  });

  it('reports nothing when the required input is satisfied by the node config', () => {
    expect(
      findMissingRequiredCustomNodeInputs(
        { repo: { type: 'string', required: true } },
        { repo: 'owner/repo' },
      ),
    ).toEqual([]);
  });

  it('reports nothing when the required input carries a manifest default', () => {
    expect(
      findMissingRequiredCustomNodeInputs(
        { state: { type: 'string', required: true, default: 'open' } },
        {},
      ),
    ).toEqual([]);
  });

  it('skips a templated value, which is only knowable at run time', () => {
    // The runtime re-checks after rendering; guessing here would flag correct flows.
    expect(
      findMissingRequiredCustomNodeInputs(
        { repo: { type: 'string', required: true } },
        { repo: '{{previous.repo}}' },
      ),
    ).toEqual([]);
  });

  it('never reports reserved projectId, which the flow may supply', () => {
    expect(
      findMissingRequiredCustomNodeInputs({ projectId: { type: 'string', required: true } }, {}),
    ).toEqual([]);
  });

  it('leaves an input optional when "required" is absent', () => {
    expect(findMissingRequiredCustomNodeInputs({ a: { type: 'string' } }, {})).toEqual([]);
  });

  it('treats zero and false as real values, never as missing', () => {
    // Guards against a future refactor reaching for a plain truthiness check on the config value.
    expect(
      findMissingRequiredCustomNodeInputs(
        {
          count: { type: 'number', required: true },
          dryRun: { type: 'boolean', required: true },
        },
        { count: 0, dryRun: false },
      ),
    ).toEqual([]);
  });

  it('reports an explicit null, which an MCP-authored config can write', () => {
    expect(
      findMissingRequiredCustomNodeInputs(
        { repo: { type: 'string', required: true } },
        { repo: null },
      ),
    ).toEqual(['repo']);
  });

  it('skips a template embedded in surrounding text, not just a whole-field one', () => {
    expect(
      findMissingRequiredCustomNodeInputs(
        { branch: { type: 'string', required: true } },
        { branch: 'release/{{previous.version}}' },
      ),
    ).toEqual([]);
  });

  it('does not let a blank declared default satisfy the requirement', () => {
    // Must agree with the runtime, which refuses to dispatch the empty value.
    expect(
      findMissingRequiredCustomNodeInputs(
        { repo: { type: 'string', required: true, default: '' } },
        {},
      ),
    ).toEqual(['repo']);
    expect(
      findMissingRequiredCustomNodeInputs(
        { repo: { type: 'string', required: true, default: null } },
        {},
      ),
    ).toEqual(['repo']);
  });

  it('tolerates a missing config object entirely', () => {
    expect(
      findMissingRequiredCustomNodeInputs({ repo: { type: 'string', required: true } }, undefined),
    ).toEqual(['repo']);
  });

  it('names every missing input, in manifest declaration order', () => {
    expect(
      findMissingRequiredCustomNodeInputs(
        {
          repo: { type: 'string', required: true },
          optional: { type: 'string' },
          branch: { type: 'string', required: true },
        },
        { optional: '' },
      ),
    ).toEqual(['repo', 'branch']);
  });
});

describe('parseManifestInputDeclarations', () => {
  it('keeps well-formed declarations, including the fields it does not read', () => {
    expect(
      parseManifestInputDeclarations({
        repo: { type: 'string', required: true, default: 'owner/repo' },
      }),
    ).toEqual({ repo: { type: 'string', required: true, default: 'owner/repo' } });
  });

  it('keeps the well-formed fields of a declaration with a non-boolean "required", not enforcing it', () => {
    // Discovery warns about this separately; here it must simply not be enforced, while the
    // configured value must still reach the script through the declaration's surviving fields.
    const parsed = parseManifestInputDeclarations({ repo: { type: 'string', required: 'true' } });
    expect(parsed).toEqual({ repo: { type: 'string' } });
    expect(findMissingRequiredCustomNodeInputs(parsed, {})).toEqual([]);
  });

  it('keeps a "template": false opt-out, including on an otherwise malformed declaration', () => {
    expect(parseManifestInputDeclarations({ q: { type: 'string', template: false } })).toEqual({
      q: { type: 'string', template: false },
    });
    // Salvage keeps only an explicit false; anything else stays rendered (the default).
    expect(
      parseManifestInputDeclarations({
        a: { required: 'yes', template: false },
        b: { required: 'yes', template: 'no' },
      }),
    ).toEqual({ a: { template: false }, b: {} });
  });

  it('keeps entries that are not objects as bare optional declarations', () => {
    expect(parseManifestInputDeclarations({ a: 'not-an-object', b: 42, c: null })).toEqual({
      a: {},
      b: {},
      c: {},
    });
  });

  it('returns nothing for an inputs block that is not an object', () => {
    expect(parseManifestInputDeclarations([])).toEqual({});
    expect(parseManifestInputDeclarations(null)).toEqual({});
    expect(parseManifestInputDeclarations('nonsense')).toEqual({});
  });
});

describe('isTemplateRenderedInput', () => {
  it('renders by default and opts out only on an explicit false', () => {
    expect(isTemplateRenderedInput(undefined)).toBe(true);
    expect(isTemplateRenderedInput({})).toBe(true);
    expect(isTemplateRenderedInput({ template: true })).toBe(true);
    expect(isTemplateRenderedInput({ template: false })).toBe(false);
  });

  it('counts an opted-out required value holding {{...}} as present', () => {
    expect(
      findMissingRequiredCustomNodeInputs(
        { q: { required: true, template: false } },
        { q: '{{field}}' },
      ),
    ).toEqual([]);
  });
});
