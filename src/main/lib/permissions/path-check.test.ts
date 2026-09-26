import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPathWithinProject } from './path-check';

// The dev workspace path itself contains spaces ("Personal and learning"), so agents that
// copy a shell-escaped path (`/…/Personal\ and\ learning/…`) from a prior bash command into
// a Read tool's file_path would otherwise be flagged as reading an "external" path.
describe('isPathWithinProject', () => {
  let projectRoot: string;

  beforeEach(() => {
    // Prefix has a space on purpose so escaped/unescaped forms differ.
    projectRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'frink path ')));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('accepts a real in-project file', () => {
    const file = join(projectRoot, 'index.ts');
    writeFileSync(file, '// test');
    expect(isPathWithinProject(file, projectRoot)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'accepts a shell-escaped in-project path (backslash-escaped spaces)',
    () => {
      const file = join(projectRoot, 'index.ts');
      writeFileSync(file, '// test');
      const escaped = file.replace(/ /g, '\\ ');
      expect(escaped).toContain('\\ ');
      expect(isPathWithinProject(escaped, projectRoot)).toBe(true);
    },
  );

  it('rejects an absolute path outside the project', () => {
    expect(isPathWithinProject('/etc/hosts', projectRoot)).toBe(false);
  });

  it('rejects a traversal escape', () => {
    expect(isPathWithinProject(join(projectRoot, '../../etc/passwd'), projectRoot)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'does not let shell-escaping smuggle an outside path in',
    () => {
      // Unescapes to a path that still resolves outside the project → stays outside.
      expect(isPathWithinProject('/some other\\ dir/secret', projectRoot)).toBe(false);
    },
  );

  it('rejects a sibling directory that shares a name prefix (proj vs proj-evil)', () => {
    // Classic containment bug: startsWith must require a separator after the root.
    const evil = `${projectRoot}-evil`;
    mkdirSync(evil, { recursive: true });
    try {
      const file = join(evil, 'secret.ts');
      writeFileSync(file, '// x');
      expect(isPathWithinProject(file, projectRoot)).toBe(false);
    } finally {
      rmSync(evil, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'rejects an in-project symlink that escapes outside the project (incl. shell-escaped)',
    () => {
      const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'frink outside ')));
      try {
        const secret = join(outside, 'secret.ts');
        writeFileSync(secret, '// x');
        const link = join(projectRoot, 'link.ts');
        symlinkSync(secret, link);
        // realpath resolves the symlink to outside → not contained, via both forms.
        expect(isPathWithinProject(link, projectRoot)).toBe(false);
        expect(isPathWithinProject(link.replace(/ /g, '\\ '), projectRoot)).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );
});
