import { describe, expect, it } from 'vitest';
import { computeBaseline } from './build-skill-content';

type VersionContextBuilder = (
  outputs: ReadonlyMap<string, string>,
  packageVersion: string,
) => ReturnType<typeof computeBaseline>;

const buildInVersionContext = computeBaseline as VersionContextBuilder;

describe('build-skill-content baseline', () => {
  it('is identical across package-version contexts when generated content is unchanged', () => {
    const outputs = new Map([
      ['SKILL.md', '# frink-flows\n'],
      ['references/topic.md', 'same generated content\n'],
    ]);

    const featureBaseline = buildInVersionContext(outputs, '0.0.9');
    const targetBaseline = buildInVersionContext(outputs, '0.0.10');

    expect(featureBaseline).toEqual(targetBaseline);
    expect(featureBaseline.version).toMatch(/^content-[a-f0-9]{12}$/);
    expect(featureBaseline.generatedAt).toBe(featureBaseline.version);
  });

  it('canonicalizes insertion order and manifest path separators', () => {
    const posixOutputs = new Map([
      ['SKILL.md', '# frink-flows\n'],
      ['references/topic.md', 'generated content\n'],
    ]);
    const windowsOutputs = new Map([
      ['references\\topic.md', 'generated content\n'],
      ['SKILL.md', '# frink-flows\n'],
    ]);

    expect(computeBaseline(posixOutputs)).toEqual(computeBaseline(windowsOutputs));
  });

  it('changes identity when content changes without changing its byte length', () => {
    const before = computeBaseline(new Map([['references/topic.md', 'before']]));
    const after = computeBaseline(new Map([['references/topic.md', 'after!']]));

    expect(Buffer.byteLength('before')).toBe(Buffer.byteLength('after!'));
    expect(after.files['references/topic.md']?.sha256).not.toBe(
      before.files['references/topic.md']?.sha256,
    );
    expect(after.version).not.toBe(before.version);
  });
});
