import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import { searchTargetsProtectedPath } from './protected-selector';
import { searchRootFromInput } from './search-root';

/** Run `fn` with `process.platform` pinned, so case-folding is tested the same on every host. */
function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original });
  }
}

const home = nodeOs.homedir();

describe('searchRootFromInput', () => {
  it('defaults to the cwd when Grep has no path (or an empty one)', () => {
    expect(searchRootFromInput('Grep', { pattern: 'x' })).toBe('.');
    expect(searchRootFromInput('Grep', { pattern: 'x', path: '' })).toBe('.');
  });

  it('ignores a non-string path instead of throwing', () => {
    expect(searchRootFromInput('Grep', { pattern: 'x', path: 42 })).toBe('.');
    expect(searchRootFromInput('Grep', null)).toBe('.');
  });

  it('expands a tilde path', () => {
    expect(searchRootFromInput('Grep', { pattern: 'x', path: '~/.ssh' })).toBe(
      nodePath.join(home, '.ssh'),
    );
    expect(searchRootFromInput('Grep', { pattern: 'x', path: '~' })).toBe(home);
  });

  it('Grep ignores its `glob` filter', () => {
    expect(searchRootFromInput('Grep', { pattern: 'x', path: 'src', glob: '/etc/**' })).toBe('src');
  });

  it('Glob joins the pattern’s static prefix onto path', () => {
    expect(searchRootFromInput('Glob', { pattern: '**/*.ts' })).toBe('.');
    expect(searchRootFromInput('Glob', { pattern: 'src/**/*.ts', path: 'pkg' })).toBe(
      nodePath.join('pkg', 'src'),
    );
    expect(searchRootFromInput('Glob', { pattern: '../../.ssh/*' })).toBe(
      nodePath.join('..', '..', '.ssh'),
    );
  });

  it('Glob absolute and tilde patterns replace the base path', () => {
    expect(searchRootFromInput('Glob', { pattern: '/etc/*.conf', path: 'src' })).toBe('/etc');
    expect(searchRootFromInput('Glob', { pattern: '~/.aws/*' })).toBe(nodePath.join(home, '.aws'));
  });

  it('Glob with a literal (non-glob) pattern roots at that file', () => {
    expect(searchRootFromInput('Glob', { pattern: 'package.json' })).toBe('package.json');
  });

  it('Glob with `..` after a wildcard widens to the filesystem root', () => {
    expect(searchRootFromInput('Glob', { pattern: '**/../../x', path: '/a/b' })).toBe('/');
  });

  it('Glob alternatives that span directories widen to the filesystem root', () => {
    expect(searchRootFromInput('Glob', { pattern: '{src,/etc}/**', path: '/p' })).toBe('/');
    expect(searchRootFromInput('Glob', { pattern: 'src/{a,../../x}/*', path: '/p' })).toBe('/');
    expect(searchRootFromInput('Glob', { pattern: '@(src|/etc)/**', path: '/p' })).toBe('/');
    expect(searchRootFromInput('Glob', { pattern: '{..,src}/*', path: '/p' })).toBe('/');
  });

  it('Glob segments that can match `..` widen to the filesystem root', () => {
    expect(searchRootFromInput('Glob', { pattern: '[.][.]/[.][.]/.ssh/**', path: '/p' })).toBe('/');
    expect(searchRootFromInput('Glob', { pattern: '.?/x', path: '/p' })).toBe('/');
    expect(searchRootFromInput('Glob', { pattern: '@(..|x)/y', path: '/p' })).toBe('/');
  });

  it('escaped characters in the static prefix resolve to their literal path', () => {
    expect(searchRootFromInput('Glob', { pattern: '\\.\\./.ssh/**', path: '/p/q' })).toBe(
      '/p/.ssh',
    );
    expect(searchRootFromInput('Glob', { pattern: 'src/\\[x\\]/*.ts', path: '/p' })).toBe(
      '/p/src/[x]',
    );
  });

  it('a brace range names files, not a parent directory', () => {
    expect(searchRootFromInput('Glob', { pattern: 'src/file{1..3}.ts', path: '/p' })).toBe(
      '/p/src',
    );
    expect(searchRootFromInput('Glob', { pattern: 'src/{a..c}/*.ts', path: '/p' })).toBe('/p/src');
  });

  it('extension alternatives and nested groups inside one segment stay put', () => {
    expect(searchRootFromInput('Glob', { pattern: '**/*.{ts,tsx}', path: '/p' })).toBe('/p');
    expect(searchRootFromInput('Glob', { pattern: 'src/**/*.{j,t}s{,x}', path: '/p' })).toBe(
      '/p/src',
    );
    expect(searchRootFromInput('Glob', { pattern: 'src/*.{a,{b,c}}', path: '/p' })).toBe('/p/src');
  });

  it('a negated Glob searches from its path, not into the excluded prefix', () => {
    expect(searchRootFromInput('Glob', { pattern: '!.ssh/**', path: '/p' })).toBe('/p');
  });
});

describe('searchTargetsProtectedPath', () => {
  const targets = (toolName: string, input: object) => searchTargetsProtectedPath(toolName, input);

  it('flags a Glob that names a protected dot-path anywhere below its root', () => {
    expect(targets('Glob', { pattern: '**/.ssh/**' })).toBe(true);
    expect(targets('Glob', { pattern: '**/.ssh/*' })).toBe(true);
    expect(targets('Glob', { pattern: '*/.aws/*' })).toBe(true);
    expect(targets('Glob', { pattern: 'src/**/.env*' })).toBe(true);
    expect(targets('Glob', { pattern: '**/.config/gcloud/*' })).toBe(true);
    expect(targets('Glob', { pattern: '**/.*' })).toBe(true);
  });

  it('flags a Grep `glob` filter that selects protected dot-paths', () => {
    expect(targets('Grep', { pattern: 'KEY', glob: '**/.env*' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: '.ssh/*' })).toBe(true);
  });

  it('flags negated selectors, which select everything else', () => {
    expect(targets('Glob', { pattern: '!.ssh/**' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: '!*.ts' })).toBe(true);
  });

  it('leaves ordinary wildcard searches alone (wildcards skip dot-names)', () => {
    expect(targets('Glob', { pattern: '**/*' })).toBe(false);
    expect(targets('Glob', { pattern: 'src/**/*.{ts,tsx}' })).toBe(false);
    expect(targets('Grep', { pattern: 'x', glob: '*.ts' })).toBe(false);
    expect(targets('Grep', { pattern: '.ssh' })).toBe(false);
    expect(targets('Glob', {})).toBe(false);
  });

  it('Grep filters that select non-dot secrets count (Grep reads contents)', () => {
    expect(targets('Grep', { pattern: 'x', glob: '**/credentials.json' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: 'secrets.*' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: '**/*.pem' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: '*.{pem,txt}' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: 'id_rsa*' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: 'config/secrets.y*' })).toBe(true);
  });

  it('Glob names-only listings of non-dot secrets do not count', () => {
    expect(targets('Glob', { pattern: '**/*.pem' })).toBe(false);
  });

  it('fixed-depth selectors are caught at any depth', () => {
    expect(targets('Grep', { pattern: 'x', glob: 'a/b/c/.env*' })).toBe(true);
    expect(targets('Glob', { pattern: 'a/*/c/d/.ssh/*' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: 'a/b/c/d/secrets.yml' })).toBe(true);
  });

  it('the deny list’s .env.example exemption carries over to selectors', () => {
    expect(targets('Glob', { pattern: '**/.env.example' })).toBe(false);
    expect(targets('Grep', { pattern: 'x', glob: 'config/.env.example' })).toBe(false);
    expect(targets('Glob', { pattern: '**/.env.local' })).toBe(true);
  });

  it('a single-character wildcard cannot disguise a protected name', () => {
    expect(targets('Grep', { pattern: 'x', glob: '.env.?xample' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: 'id_?sa' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: '*.p?m' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: 'secrets.??' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: 'id_*' })).toBe(true);
    expect(targets('Glob', { pattern: '**/@(.ssh)/*' })).toBe(true);
  });

  it('a wildcard never names a dot-path implicitly', () => {
    expect(targets('Glob', { pattern: '**/?ssh/*' })).toBe(false);
    expect(targets('Glob', { pattern: '*/*' })).toBe(false);
    expect(targets('Grep', { pattern: 'x', glob: 'src/**/*' })).toBe(false);
  });

  it('a plain type filter counts only when every file it selects is protected', () => {
    expect(targets('Grep', { pattern: 'x', glob: '*.ts' })).toBe(false);
    expect(targets('Grep', { pattern: 'x', glob: '**/*.json' })).toBe(false);
    expect(targets('Grep', { pattern: 'x', glob: 'etc/**' })).toBe(false);
    expect(targets('Grep', { pattern: 'x', glob: '*.key' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: 'certs/*.pem' })).toBe(true);
  });

  it('selectors fold case where the filesystem does (macOS / Windows), not on Linux', () => {
    withPlatform('darwin', () => {
      expect(targets('Glob', { pattern: '**/.SSH/**' })).toBe(true);
      expect(targets('Grep', { pattern: 'x', glob: '**/.ENV' })).toBe(true);
      expect(targets('Grep', { pattern: 'x', glob: 'ID_RSA' })).toBe(true);
      expect(targets('Grep', { pattern: 'x', glob: '*.PEM' })).toBe(true);
      expect(targets('Glob', { pattern: '**/.Env.Example' })).toBe(false);
    });
    withPlatform('linux', () => {
      expect(targets('Glob', { pattern: '**/.SSH/**' })).toBe(false);
      expect(targets('Grep', { pattern: 'x', glob: '*.PEM' })).toBe(false);
      expect(targets('Glob', { pattern: '**/.ssh/**' })).toBe(true);
    });
  });

  it('an even run of leading `!` is positive, an odd run negates', () => {
    expect(targets('Grep', { pattern: 'x', glob: '!!*.ts' })).toBe(false);
    expect(targets('Grep', { pattern: 'x', glob: '!!.env' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: '!!!*.ts' })).toBe(true);
    expect(searchRootFromInput('Glob', { pattern: '!!.ssh/**', path: '/p' })).toBe('/p/.ssh');
    expect(searchRootFromInput('Glob', { pattern: '!.ssh/**', path: '/p' })).toBe('/p');
  });

  it('nested extglobs are unwrapped fully; unparseable or dir-spanning ones count', () => {
    expect(targets('Glob', { pattern: '@(.ssh|@(foo))/**' })).toBe(true);
    expect(targets('Glob', { pattern: '**/+(@(.aws))/*' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: '@(src/.env|x)' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: '@(a' })).toBe(true);
    expect(targets('Glob', { pattern: 'src/@(a|@(b))/*.ts' })).toBe(false);
  });

  it('POSIX and bracket-edge classes cannot disguise a protected name', () => {
    expect(targets('Grep', { pattern: 'x', glob: '**/.s[[:alpha:]]h/**' })).toBe(true);
    expect(targets('Glob', { pattern: '**/.[[:lower:]]sh/*' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: '**/.s[]s]h/*' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: '[[:alpha:' })).toBe(true);
  });

  it('an escaped glob character is a literal, never a wildcard', () => {
    expect(targets('Grep', { pattern: 'x', glob: '\\*.ts' })).toBe(false);
    expect(targets('Grep', { pattern: 'x', glob: '\\*.pem' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: '\\{.env,x\\}' })).toBe(false);
    expect(targets('Grep', { pattern: 'x', glob: '\\!.env' })).toBe(false);
  });

  it('an explosion of brace alternatives is treated as protected', () => {
    const glob = '{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}';
    expect(targets('Grep', { pattern: 'x', glob })).toBe(true);
  });

  it('character classes and escapes cannot disguise a protected name', () => {
    expect(targets('Grep', { pattern: 'x', glob: '[.]ssh/[i]d_rsa' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: '[ij]d_rsa' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: '?d_rsa' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: '\\.env' })).toBe(true);
    expect(targets('Glob', { pattern: '**/.[s]sh/*' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: '[c]redentials.json' })).toBe(true);
    expect(targets('Grep', { pattern: 'x', glob: '[a-z]ecrets.yml' })).toBe(true);
  });

  it('plain wildcard Grep filters do not count', () => {
    expect(targets('Grep', { pattern: 'x', glob: '**/*' })).toBe(false);
    expect(targets('Grep', { pattern: 'x', glob: '*.*' })).toBe(false);
    expect(targets('Grep', { pattern: 'x', glob: 'src/**/*.ts' })).toBe(false);
  });
});
