import { describe, expect, it } from 'vitest';
import {
  appRootOf,
  isIgnoredPort,
  labelFromCommand,
  parseLsofCwds,
  parseLsofListeners,
  parsePsCommands,
  toUrl,
} from './port-scanner';

describe('parseLsofListeners', () => {
  it('reads every listening socket per process from lsof field output', () => {
    const stdout = [
      'p702',
      'cnode',
      'f10',
      'n*:5173',
      'f11',
      'n[::1]:5174',
      'p900',
      'cbun',
      'f3',
      'n127.0.0.1:3000',
      '',
    ].join('\n');
    expect(parseLsofListeners(stdout)).toEqual([
      { pid: 702, command: 'node', address: '*', port: 5173 },
      { pid: 702, command: 'node', address: '::1', port: 5174 },
      { pid: 900, command: 'bun', address: '127.0.0.1', port: 3000 },
    ]);
  });

  it('skips names that are not address:port', () => {
    expect(parseLsofListeners('p1\ncx\nnnot-a-socket\n')).toEqual([]);
  });
});

describe('parseLsofCwds', () => {
  it('maps each pid to its working folder', () => {
    const stdout = 'p702\nfcwd\nn/Users/me/repo\np900\nfcwd\nn/Users/me/folder with space\n';
    expect(parseLsofCwds(stdout)).toEqual(
      new Map([
        [702, '/Users/me/repo'],
        [900, '/Users/me/folder with space'],
      ]),
    );
  });
});

describe('parsePsCommands', () => {
  it('maps each pid to its full command line', () => {
    const stdout =
      '  702 /usr/local/bin/node /repo/node_modules/.bin/vite --port 5174\n 900 next-server (v15.1.0)\n';
    expect(parsePsCommands(stdout)).toEqual(
      new Map([
        [702, '/usr/local/bin/node /repo/node_modules/.bin/vite --port 5174'],
        [900, 'next-server (v15.1.0)'],
      ]),
    );
  });
});

describe('labelFromCommand', () => {
  it.each([
    ['/usr/local/bin/node /repo/node_modules/.bin/vite --port 5174', 'vite'],
    ['node --inspect /repo/node_modules/next/dist/bin/next.js dev', 'next'],
    ['/Users/me/.bun/bin/bun run server.ts', 'server'],
    ['python3 -m http.server 8000', 'http.server'],
    ['next-server (v15.1.0)', 'next-server'],
    ['/opt/homebrew/bin/caddy run', 'caddy'],
  ])('%s → %s', (command, label) => {
    expect(labelFromCommand(command)).toBe(label);
  });

  it('keeps a script path whole when the server folder contains spaces', () => {
    const cwd = '/Users/me/Personal and learning/app';
    expect(labelFromCommand(`/usr/bin/node ${cwd}/node_modules/.bin/vite`, cwd)).toBe('vite');
  });

  it('recognises the macOS framework Python and versioned runtimes', () => {
    const python =
      '/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python -m http.server 8765';
    expect(labelFromCommand(python)).toBe('http.server');
    expect(labelFromCommand('python3.12 manage.py runserver')).toBe('manage');
    expect(labelFromCommand('node ./scripts/server.mts')).toBe('server');
  });

  it('skips the value of a runtime flag such as a preloaded module', () => {
    expect(labelFromCommand('node -r dotenv/config server.js')).toBe('server');
    expect(labelFromCommand('node --import tsx ./src/index.ts')).toBe('index');
    expect(labelFromCommand('node --require=ts-node/register app.ts')).toBe('app');
  });

  it('names the runtime when it evaluates inline code instead of a script', () => {
    expect(labelFromCommand(`node -e require('http').createServer().listen(3000)`)).toBe('node');
  });

  it('returns null for an empty command', () => {
    expect(labelFromCommand('  ')).toBeNull();
  });
});

describe('isIgnoredPort', () => {
  it.each([22, 443, 5432, 9222, 9229, 49152, 61000])('ignores %i', (port) => {
    expect(isIgnoredPort(port)).toBe(true);
  });

  it.each([3000, 5173, 8080, 9221, 9230, 49151])('keeps %i', (port) => {
    expect(isIgnoredPort(port)).toBe(false);
  });
});

describe('toUrl', () => {
  it.each([
    ['*', 'http://localhost:5173'],
    ['0.0.0.0', 'http://localhost:5173'],
    ['127.0.0.1', 'http://localhost:5173'],
    ['::1', 'http://localhost:5173'],
    ['::', 'http://localhost:5173'],
    ['192.168.1.5', 'http://192.168.1.5:5173'],
    ['fe80::1', 'http://[fe80::1]:5173'],
  ])('%s', (address, url) => {
    expect(toUrl(address, 5173)).toBe(url);
  });
});

describe('appRootOf', () => {
  it.each([
    ['/Applications/Frink.app/Contents/MacOS/Frink', '/Applications/Frink.app/'],
    [
      '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      '/repo/node_modules/electron/dist/Electron.app/',
    ],
    ['/opt/Frink/frink', '/opt/Frink/'],
  ])('%s → %s', (execPath, root) => {
    expect(appRootOf(execPath)).toBe(root);
  });
});
