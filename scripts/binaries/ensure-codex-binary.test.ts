import { describe, expect, it } from 'vitest';
import manifest from '../../patches/codex/manifest.json';
import { codexVersionStamp } from './build-codex-frink.mjs';
import { codexStampDrift, driftWarning } from './ensure-codex-binary.mjs';

const CURRENT = codexVersionStamp(manifest);
const OLDER = 'rust-v0.149.0+frink.000000000000';

/** One injected reader serves both files the drift check reads. */
function reader(stamp: string | Error, patchSha256 = manifest.patchSha256) {
  return (filePath: string) => {
    if (String(filePath).endsWith('manifest.json')) {
      return JSON.stringify({ ...manifest, patchSha256 });
    }
    if (stamp instanceof Error) throw stamp;
    return `${stamp}\n`;
  };
}

describe('codexStampDrift', () => {
  it('reports no drift when the stamp matches the manifest', () => {
    expect(codexStampDrift('/repo', reader(CURRENT))).toBeNull();
  });

  it('reports drift when the binary was built from an older patch', () => {
    expect(codexStampDrift('/repo', reader(OLDER))).toEqual({ expected: CURRENT, actual: OLDER });
  });

  it('reports an absent binary distinctly from a stale one', () => {
    expect(codexStampDrift('/repo', reader(new Error('ENOENT')))).toEqual({
      expected: CURRENT,
      actual: null,
    });
  });

  it('refuses a manifest the build script itself would reject', () => {
    expect(() => codexStampDrift('/repo', reader(CURRENT, 'deadbeef'))).toThrow(
      /Invalid pinned Codex source manifest/,
    );
  });
});

describe('driftWarning', () => {
  it('tells a checkout with no binary to copy one rather than compile for an hour', () => {
    const message = driftWarning({ expected: CURRENT, actual: null });
    expect(message).toContain('Symlink or copy');
    expect(message).not.toContain('older patch');
  });

  it('tells a stale checkout to rebuild, naming both stamps', () => {
    const message = driftWarning({ expected: CURRENT, actual: OLDER });
    expect(message).toContain(CURRENT);
    expect(message).toContain(OLDER);
    expect(message).toContain('bun run codex:build');
  });
});
