import { describe, expect, it } from 'vitest';
import {
  bareFileNameTarget,
  type FileLinkTarget,
  fileLinkOpenInput,
  fileLinkOpenInputAcrossProjects,
  fileLinkOwnMainFolder,
  fileLinkProject,
  findShortenedPath,
  inlineCodeFileTarget,
  isBareFileName,
  isBareRelativePath,
  isFileNameLabel,
  parseFileLinkTarget,
  resolveFileLinkClick,
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

describe('bareFileNameTarget', () => {
  it.each([
    'index.ts',
    ' package.json ',
    'README.md',
    'chat-markdown-renderer.tsx',
    'vite.config.mts',
    'main.pl',
    'setup.cc',
    // A host-shaped name is only looked up: no project file matches it, so it stays code.
    'example.com',
  ])('reads %j as a name a project lookup may place', (code) => {
    expect(bareFileNameTarget(code)).toEqual({ path: code.trim() });
  });

  it.each([
    'foo',
    '.env',
    '.eslintrc.json',
    'a b.ts',
    '*.ts',
    '<name>.ts',
    'glm-5.3',
    'v1.2.3',
    'localhost',
    'src/a.ts',
    'index.ts:12',
    'https:x.ts',
    'a\\b.ts',
    'foo.',
  ])('keeps %j as code', (code) => {
    expect(bareFileNameTarget(code)).toBeNull();
  });
});

describe('isBareFileName', () => {
  it('tells a name alone from a path', () => {
    expect(isBareFileName('index.ts')).toBe(true);
    expect(isBareFileName('src/index.ts')).toBe(false);
    expect(isBareFileName('/Users/x/index.ts')).toBe(false);
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

describe('fileLinkOpenInputAcrossProjects', () => {
  const projects = [
    { id: 'code', name: 'code', path: '/Users/sam/code' },
    { id: 'app', name: 'app', path: '/Users/sam/code/app' },
    { id: 'ui', name: 'ui', path: '/Users/sam/code/app/packages/ui' },
    { id: 'api', name: 'api', path: '/Users/sam/code/api' },
  ];
  const chat: Parameters<typeof fileLinkOpenInput>[1] = {
    home: '/Users/sam',
    root: '/Users/sam/code/app',
    isWorktreeContext: false,
    chatId: 'chat-1',
  };
  const worktreeChat = {
    ...chat,
    root: '/Users/sam/.frink/worktrees/app/fix',
    isWorktreeContext: true,
  };
  const open = (file: string, base = chat, chatProjectId: string | null = 'app') =>
    fileLinkOpenInputAcrossProjects(file, base, projects, chatProjectId);

  it("opens a full path in another project as that project's file", () => {
    expect(open('/Users/sam/code/api/src/a.ts')).toEqual({
      path: 'src/a.ts',
      name: 'a.ts',
      projectPath: '/Users/sam/code/api',
      isWorktreeContext: false,
      sourceChatId: 'chat-1',
      intent: 'pinned',
      isOtherProject: true,
      projectName: 'api',
    });
  });

  it.each([
    ['a ~/ path', '~/code/api/src/a.ts', chat, 'app', 'api'],
    ['a worktree chat', '/Users/sam/code/api/src/a.ts', worktreeChat, 'app', 'api'],
    ['a general chat', '/Users/sam/code/app/src/a.ts', { ...chat, root: undefined }, null, 'app'],
    ["the project around the chat's", '/Users/sam/code/notes.md', chat, 'app', 'code'],
    [
      "the project around a worktree chat's",
      '/Users/sam/code/notes.md',
      worktreeChat,
      'app',
      'code',
    ],
  ])('opens %s in the project it names', (_, file, base, chatProjectId, projectName) => {
    expect(open(file, base, chatProjectId)).toMatchObject({
      projectName,
      isOtherProject: true,
      isWorktreeContext: false,
    });
  });

  it("opens a nested project's file in the chat's own folder, which it tries first", () => {
    const input = open('/Users/sam/code/app/packages/ui/a.ts');
    expect(input).toMatchObject({ path: 'packages/ui/a.ts', projectPath: '/Users/sam/code/app' });
    expect(input?.isOtherProject).toBeUndefined();
  });

  it.each([
    ['outside every project', '/Users/sam/other/a.ts', chat, 'app'],
    ['written relative to the chat folder', '../api/a.ts', chat, 'app'],
    [
      'starting ~/ before the home folder is known',
      '~/code/api/a.ts',
      { ...chat, home: undefined },
      'app',
    ],
    ["in a worktree chat's own main folder", '/Users/sam/code/app/src/a.ts', worktreeChat, 'app'],
    // The file is ui's too, but it still lies in app's main folder, not the worktree.
    [
      "in a project kept inside a worktree chat's own main folder",
      '/Users/sam/code/app/packages/ui/a.ts',
      worktreeChat,
      'app',
    ],
    [
      "in a worktree chat's own main folder, under a project of its own",
      '/Users/sam/code/app/src/a.ts',
      { ...worktreeChat, root: '/Users/sam/.frink/worktrees/code/fix' },
      'code',
    ],
  ])('opens nothing for a path %s', (_, file, base, chatProjectId) => {
    expect(open(file, base, chatProjectId)).toBeNull();
  });
});

describe('fileLinkProject', () => {
  const projects = [{ id: 'api', name: 'api', path: '/Users/sam/code/api' }];

  it.each([
    ['a full path', '/Users/sam/code/api/a.ts', '/Users/sam', 'api'],
    ['a ~/ path', '~/code/api/a.ts', '/Users/sam', 'api'],
    ['a ~/ path before the home folder is known', '~/code/api/a.ts', undefined, undefined],
    ['a relative path', 'code/api/a.ts', '/Users/sam', undefined],
  ])('finds the project of %s', (_, file, home, id) => {
    expect(fileLinkProject(file, home, projects)?.id).toBe(id);
  });
});

describe('fileLinkOwnMainFolder', () => {
  const projects = [
    { id: 'app', name: 'app', path: '/Users/sam/code/app' },
    { id: 'ui', name: 'ui', path: '/Users/sam/code/app/packages/ui' },
  ];
  const worktree = { home: '/Users/sam', isWorktreeContext: true };

  it.each([
    ['a file in the main folder', '/Users/sam/code/app/src/a.ts'],
    ['a file in a project kept inside it', '~/code/app/packages/ui/a.ts'],
  ])("names the worktree chat's own project for %s", (_, file) => {
    expect(fileLinkOwnMainFolder(file, worktree, projects, 'app')?.id).toBe('app');
  });

  it.each([
    [
      'a chat with no worktree',
      '/Users/sam/code/app/src/a.ts',
      { ...worktree, isWorktreeContext: false },
    ],
    ['a file outside the main folder', '/Users/sam/code/api/a.ts', worktree],
    ['a relative path', 'src/a.ts', worktree],
  ])('names no project for %s', (_, file, base) => {
    expect(fileLinkOwnMainFolder(file, base, projects, 'app')).toBeNull();
  });
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

  it('reads entries listed with Windows separators', () => {
    const windows = [{ path: 'src\\main\\lib\\store.ts' }, { path: 'src\\renderer\\store.ts' }];
    expect(findShortenedPath('lib/store.ts', windows)).toBe('src\\main\\lib\\store.ts');
  });
});

describe('resolveFileLinkClick', () => {
  type Answers = Record<string, 'file' | 'folder' | 'unavailable' | null>;
  const click = async (path: string, answers: Answers, searchHits: string[] = []) => {
    const searched: string[] = [];
    const result = await resolveFileLinkClick({ path, name: 'notes.md' }, { path }, 'app', {
      typeAt: async (at) => answers[at] ?? null,
      search: async (query) => {
        searched.push(query);
        return searchHits.map((hit) => ({ path: hit }));
      },
    });
    return { result, searched };
  };

  it("says a file whose drive isn't answering isn't answering, and searches nothing for it", async () => {
    expect(await click('nas/notes.md', { 'nas/notes.md': 'unavailable' })).toEqual({
      result: { problem: "notes.md isn't answering. Its drive may be disconnected or asleep." },
      searched: [],
    });
  });

  it('opens a shortened path at the only project entry that ends with it', async () => {
    const { result } = await click('lib/notes.md', { 'src/lib/notes.md': 'file' }, [
      'src/lib/notes.md',
    ]);
    expect(result).toEqual({ open: 'src/lib/notes.md' });
  });

  it("says it couldn't find a file that is nowhere, and does nothing for a folder", async () => {
    expect((await click('gone.md', {})).result).toEqual({
      problem: "Couldn't find notes.md in app",
    });
    expect((await click('docs', { docs: 'folder' })).result).toBeNull();
  });
});
