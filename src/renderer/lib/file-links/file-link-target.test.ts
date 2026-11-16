import { describe, expect, it } from 'vitest';
import {
  type FileLinkTarget,
  fileLinkOpenInput,
  findShortenedPath,
  inlineCodeFileTarget,
  isBareRelativePath,
  isFileNameLabel,
  parseFileLinkTarget,
} from './file-link-target';

describe('parseFileLinkTarget', () => {
  it.each<[string, FileLinkTarget]>([
    ['/Users/x/app.py', { path: '/Users/x/app.py' }],
    ['/Users/x/app.py:12', { path: '/Users/x/app.py', line: 12 }],
    ['/Users/x/app.py:12:5', { path: '/Users/x/app.py', line: 12 }],
    ['/Users/x/app.py#L12', { path: '/Users/x/app.py', line: 12 }],
    ['/Users/x/overlay.mts:195-233', { path: '/Users/x/overlay.mts', line: 195 }],
    ['/Users/x/app.py#L12C3', { path: '/Users/x/app.py', line: 12 }],
    ['/Users/x/app.py#L12-L20', { path: '/Users/x/app.py', line: 12 }],
    ['/Users/x/issue#12.md', { path: '/Users/x/issue#12.md' }],
    ['</Users/x/Project #1/readme.md>', { path: '/Users/x/Project #1/readme.md' }],
    ['/Users/x/notes#Later.md:4', { path: '/Users/x/notes#Later.md', line: 4 }],
    ['</Users/x/My Project/My Report.md:3>', { path: '/Users/x/My Project/My Report.md', line: 3 }],
    ['/Users/x/My Project/My Report.md', { path: '/Users/x/My Project/My Report.md' }],
    ['/Users/x/My%20Project/a.ts', { path: '/Users/x/My Project/a.ts' }],
    ['/Users/x/100%.md:4', { path: '/Users/x/100%.md', line: 4 }],
    ['file:///Users/x/a.ts', { path: '/Users/x/a.ts' }],
    ['file:///Users/x/My%20Project/a.ts#L4', { path: '/Users/x/My Project/a.ts', line: 4 }],
    ['~/notes/a.md', { path: '~/notes/a.md' }],
    ['./src/a.ts:9', { path: './src/a.ts', line: 9 }],
    ['../lib/b.ts', { path: '../lib/b.ts' }],
    ['/srv/app/Makefile', { path: '/srv/app/Makefile' }],
  ])('reads %s as a file', (url, target) => {
    expect(parseFileLinkTarget(url)).toEqual(target);
  });

  it.each([
    'https://github.com/x/y/blob/main/src/a.ts',
    'javascript:alert(1)',
    'data:text/html,hi',
    'vscode://file/Users/x/a.ts',
    'file://server/share/a.ts',
    '//cdn.example.com/a.js',
    '/chat/settings',
    '/chat/settings#L3',
    '/api/users',
    'src/a.ts',
    '#heading',
    '/Users/x/lib/*.ts',
    '/Users/',
    '/Users/x/project/',
    './',
    '../',
    '~/',
    '~/.ssh',
  ])('leaves %s as a link', (url) => {
    expect(parseFileLinkTarget(url)).toBeNull();
  });
});

describe('inlineCodeFileTarget', () => {
  it.each<[string, FileLinkTarget]>([
    ['src/a.ts:42', { path: 'src/a.ts', line: 42 }],
    ['/abs/a.ts', { path: '/abs/a.ts' }],
    ['~/x/y.json', { path: '~/x/y.json' }],
    ['cli/lib/overlay.mts:195-233', { path: 'cli/lib/overlay.mts', line: 195 }],
    ['./scripts/run', { path: './scripts/run' }],
    ['index.ts:12', { path: 'index.ts', line: 12 }],
    ['foo.cc:42', { path: 'foo.cc', line: 42 }],
    ['src/net/socket.cc', { path: 'src/net/socket.cc' }],
    ['~/.zshrc:12', { path: '~/.zshrc', line: 12 }],
    ['./.env.local', { path: './.env.local' }],
    ['.github/workflows/ci.yml', { path: '.github/workflows/ci.yml' }],
  ])('reads %s as a file', (code, target) => {
    expect(inlineCodeFileTarget(code)).toEqual(target);
  });

  it.each([
    'index.ts',
    'glm-5.3',
    'models/glm-5.3',
    'error:1',
    'port:3000',
    'localhost:3000',
    'example.com:443',
    'localhost:5173/src/main.tsx',
    '127.0.0.1:8080/a.js',
    'example.com:8080/a.ts',
    'db:5432/public/users.sql',
    'github.com/x/y.ts',
    'bbc.co.uk/news.html',
    '127.0.0.1:8080',
    '/api/users',
    'https://x.y/z.ts',
    'lib/*.ts',
    'src/**/a.ts',
    '~/.claude/projects/<slug>/memory',
    '{a,b}/c.ts',
    '$HOME/a.ts',
    'src/.../a.ts',
    'foo bar.ts',
    'npm run build',
    './',
    '../',
    '~/',
    '~/notes/',
    'src/renderer/',
    'src/lib/:12',
    '.claude/',
    '~/.claude',
    '~/.ssh',
    'apps/web/.next',
  ])('keeps %s as code', (code) => {
    expect(inlineCodeFileTarget(code)).toBeNull();
  });
});

describe('isFileNameLabel', () => {
  it.each<[string, FileLinkTarget]>([
    ['app.py', { path: '/Users/x/app.py', line: 12 }],
    ['app.py:12', { path: '/Users/x/app.py', line: 12 }],
    ['x/app.py', { path: '/Users/x/app.py' }],
    ['src/a.ts', { path: './src/a.ts' }],
    ['', { path: '/Users/x/app.py' }],
  ])('treats %j as the file name', (label, target) => {
    expect(isFileNameLabel(label, target)).toBe(true);
  });

  it.each<[string, FileLinkTarget]>([
    ['the handler', { path: '/Users/x/handler.ts' }],
    ['app.py:9', { path: '/Users/x/app.py', line: 12 }],
    ['pp.py', { path: '/Users/x/app.py' }],
  ])('keeps %j as prose', (label, target) => {
    expect(isFileNameLabel(label, target)).toBe(false);
  });
});

describe('fileLinkOpenInput', () => {
  const worktree = {
    home: '/Users/sam',
    root: '/Users/sam/.frink/worktrees/app/fix',
    isWorktreeContext: true,
    chatId: 'chat-1',
  };
  const project = { ...worktree, root: '/Users/sam/app', isWorktreeContext: false };

  it('opens a file against the worktree of a chat that has one', () => {
    expect(fileLinkOpenInput('src/a.ts', worktree)).toEqual({
      path: 'src/a.ts',
      name: 'a.ts',
      projectPath: '/Users/sam/.frink/worktrees/app/fix',
      isWorktreeContext: true,
      sourceChatId: 'chat-1',
      intent: 'pinned',
    });
  });

  it('opens a file against the project itself for a chat that runs in it', () => {
    expect(fileLinkOpenInput('src/a.ts', project)).toEqual({
      path: 'src/a.ts',
      name: 'a.ts',
      projectPath: '/Users/sam/app',
      isWorktreeContext: false,
      sourceChatId: 'chat-1',
      intent: 'pinned',
    });
  });

  it.each([
    ['/Users/sam/app/src/a.ts', 'src/a.ts'],
    ['~/app/src/a.ts', 'src/a.ts'],
    ['./src/./a.ts', 'src/a.ts'],
    ['src/lib/../a.ts', 'src/a.ts'],
  ])('reads %s as %s inside the working folder', (file, relative) => {
    expect(fileLinkOpenInput(file, project)?.path).toBe(relative);
  });

  it.each([
    '/Users/sam/other/src/a.ts',
    '/Users/sam/app',
    '~/notes/a.md',
    '../other/a.ts',
    'src/../../other/a.ts',
  ])('does not open %s, which lies outside the working folder', (file) => {
    expect(fileLinkOpenInput(file, project)).toBeNull();
  });

  it('does not join a home path to the working folder while the home folder is unknown', () => {
    expect(fileLinkOpenInput('~/app/src/a.ts', { ...project, home: undefined })).toBeNull();
  });

  it.each([{ root: undefined }, { root: null }, { chatId: null }])(
    'opens nothing without a working folder or a chat: %j',
    (missing) => {
      expect(fileLinkOpenInput('src/a.ts', { ...project, ...missing })).toBeNull();
    },
  );
});

describe('isBareRelativePath', () => {
  it.each(['src/a.ts', 'admission/store.ts', 'src/lib/../a.ts', '.github/ci.yml'])(
    'takes %s for a path that may be shortened',
    (file) => {
      expect(isBareRelativePath(file)).toBe(true);
    },
  );

  it.each(['/Users/sam/app/src/a.ts', '~/app/src/a.ts', './src/a.ts', '../other/a.ts'])(
    'takes %s for a path written in full',
    (file) => {
      expect(isBareRelativePath(file)).toBe(false);
    },
  );
});

describe('findShortenedPath', () => {
  const entries = [
    { path: 'src/main/lib/flows/admission/store.ts' },
    { path: 'src/main/lib/flows/readmission/store.ts' },
    { path: 'src/renderer/lib/store.ts' },
    { path: 'apps/mobile/ios/App.xcodeproj' },
    { path: 'src/gone.ts' },
  ];

  it('finds the one file whose path ends with a shortened path', () => {
    expect(findShortenedPath('admission/store.ts', entries)).toBe(
      'src/main/lib/flows/admission/store.ts',
    );
  });

  it('finds the one folder whose path ends with a shortened path', () => {
    expect(findShortenedPath('ios/App.xcodeproj', entries)).toBe('apps/mobile/ios/App.xcodeproj');
  });

  it.each(['store.ts', 'flows', 'mission/store.ts', 'src/gone.ts'])(
    'finds nothing for %s, which no single longer path ends with',
    (file) => {
      expect(findShortenedPath(file, entries)).toBeUndefined();
    },
  );
});
