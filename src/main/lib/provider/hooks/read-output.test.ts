import { HOOK_EVENTS, type HookEvent } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { readHookOutput } from './read-output';

type Outcome = Parameters<typeof readHookOutput>[2];
/** `json` is an object the hook prints on stdout. */
type Given = Partial<Outcome> & { json?: object };

/** Event names in sorted order, from a space-separated list. */
function names(list: string): string[] {
  return list.split(' ').sort();
}

// These lists are copied from Claude's hooks reference, not derived from the table under test.
const EXIT_2_BLOCKS = names(
  'PreToolUse UserPromptSubmit UserPromptExpansion Stop SubagentStop TeammateIdle TaskCreated ' +
    'TaskCompleted ConfigChange PostToolBatch PreCompact PreModelSwitch Elicitation ' +
    'ElicitationResult WorktreeCreate WorktreeRemove',
);
const EXIT_2_TELLS_CLAUDE = names('PostToolUse PostToolUseFailure');
const EXIT_2_TELLS_USER = names(
  'SubagentStart SessionStart SessionEnd CwdChanged FileChanged PostCompact PostModelSwitch',
);
const PLAIN_STDOUT_IS_CONTEXT = names(
  'UserPromptSubmit UserPromptExpansion SessionStart PostModelSwitch',
);
const TOP_LEVEL_BLOCK = names(
  'UserPromptSubmit UserPromptExpansion PostToolUse PostToolUseFailure PostToolBatch Stop ' +
    'SubagentStop ConfigChange PreCompact TaskCreated PreToolUse PreModelSwitch',
);
const KEEPS_ONLY_SYSTEM_MESSAGE = names('CwdChanged FileChanged DirectoryAdded TaskCreated');
const IGNORES_FAILURE = names(
  'Notification StopFailure PermissionDenied Setup InstructionsLoaded DirectoryAdded MessageDisplay',
);
const DROPS_COMMON_FIELDS = names(
  'Notification InstructionsLoaded Setup MessageDisplay ConfigChange WorktreeCreate ' +
    'WorktreeRemove PreCompact PostCompact SessionEnd Elicitation ElicitationResult StopFailure ' +
    'PermissionDenied',
);

/** Reads the outcome of a hook named `check.sh`, which exits 0 in silence unless told otherwise. */
function read(event: HookEvent, { json, stdout = '', ...extra }: Given) {
  return readHookOutput(event, 'check.sh', {
    exitCode: 0,
    signal: null,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    ...extra,
    stdout: json ? JSON.stringify(json) : stdout,
  });
}

/** The events, sorted, whose reading has `key` set for one outcome given to every event. */
function eventsWith(key: 'block' | 'error' | 'context', given: Given): string[] {
  return HOOK_EVENTS.filter((event) => read(event, given)[key] !== undefined).sort();
}

describe('readHookOutput', () => {
  it('reads a silent exit 0 as no decision on every event that needs no output', () => {
    const silent = HOOK_EVENTS.filter((event) => event !== 'WorktreeCreate');
    expect(silent.map((event) => read(event, {}))).toEqual(silent.map(() => ({})));
  });

  it('adds plain stdout as context on the four events that take it, trimmed', () => {
    expect(eventsWith('context', { stdout: ' on branch main \n' })).toEqual(
      PLAIN_STDOUT_IS_CONTEXT,
    );
    expect(read('SessionStart', { stdout: ' on branch main \n' })).toEqual({
      context: 'on branch main',
    });
    expect(read('PreToolUse', { stdout: 'on branch main', stderr: 'debug only' })).toEqual({});
  });

  describe('exit code 2', () => {
    const exit2 = { exitCode: 2, stderr: 'not allowed\n' };

    it('blocks with stderr as the reason, where the reference says exit 2 blocks or tells Claude', () => {
      expect(eventsWith('block', exit2)).toEqual([...EXIT_2_BLOCKS, ...EXIT_2_TELLS_CLAUDE].sort());
      expect(read('PreToolUse', exit2)).toEqual({
        block: { reason: '[check.sh]: not allowed\n' },
      });
      expect(read('Stop', { exitCode: 2 })).toEqual({
        block: { reason: '[check.sh]: No stderr output' },
      });
    });

    it('is a notice to the user on the events that cannot block but show stderr', () => {
      expect(eventsWith('error', exit2)).toEqual(EXIT_2_TELLS_USER);
      expect(read('SessionStart', exit2)).toEqual({ error: '[check.sh]: not allowed\n' });
    });

    it('does nothing on the events that ignore the exit code', () => {
      expect(read('Notification', exit2)).toEqual({});
      expect(read('PermissionRequest', exit2)).toEqual({});
    });

    it('cannot be overridden by JSON, which is still read', () => {
      const allow = { hookEventName: 'PreToolUse', permissionDecision: 'allow' };
      expect(read('PreToolUse', { ...exit2, json: { hookSpecificOutput: allow } })).toEqual({
        hookSpecificOutput: allow,
        block: { reason: '[check.sh]: not allowed\n' },
      });
      const quiet = { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true };
      expect(read('UserPromptSubmit', { ...exit2, json: { hookSpecificOutput: quiet } })).toEqual({
        hookSpecificOutput: quiet,
        block: { reason: '[check.sh]: not allowed\n' },
      });
    });

    it('still reads JSON on the events where it only tells the user', () => {
      const context = { hookEventName: 'SessionStart', additionalContext: 'On main' };
      const json = { decision: 'block', systemMessage: 'Careful', hookSpecificOutput: context };
      expect(read('SessionStart', { ...exit2, json })).toEqual({
        systemMessage: 'Careful',
        hookSpecificOutput: context,
        error: '[check.sh]: not allowed\n',
      });
    });

    it('takes the reason from a JSON blocking decision when there is one', () => {
      const json = { decision: 'block', reason: 'No secrets in prompts' };
      expect(read('UserPromptSubmit', { ...exit2, json })).toEqual({
        block: { reason: 'No secrets in prompts' },
      });
    });

    it.each<[string, Given]>([
      ['fails the schema', { json: { continue: 'no' } }],
      ['is not valid JSON', { stdout: '{"continue": }' }],
      ['was cut short', { stdout: '{"continue":true}', stdoutTruncated: true }],
      ['announces a background hook', { json: { async: true } }],
      ['is plain text', { stdout: 'some context' }],
    ])('still blocks with stderr when stdout %s', (_name, extra) => {
      expect(read('UserPromptSubmit', { ...exit2, ...extra })).toEqual({
        block: { reason: '[check.sh]: not allowed\n' },
      });
    });

    it.each<HookEvent>(['Elicitation', 'ElicitationResult'])(
      'ignores the hookSpecificOutput of an %s hook',
      (event) => {
        const accept = { hookEventName: event, action: 'accept', content: { name: 'a' } };
        expect(read(event, { ...exit2, json: { hookSpecificOutput: accept } })).toEqual({
          block: { reason: '[check.sh]: not allowed\n' },
        });
        expect(read(event, { json: { hookSpecificOutput: accept } })).toEqual({
          hookSpecificOutput: accept,
        });
      },
    );

    it('leaves a permission request to the decision object', () => {
      const deny = {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Not on main', interrupt: true },
      };
      expect(read('PermissionRequest', { ...exit2, json: { hookSpecificOutput: deny } })).toEqual({
        hookSpecificOutput: deny,
      });
    });
  });

  describe('any other exit code', () => {
    it.each<[string, Given, string]>([
      ['with stderr', { exitCode: 1, stderr: ' boom\nat line 3\n' }, 'boom\nat line 3'],
      ['without stderr', { exitCode: 127 }, 'No stderr output'],
      ['ended by a signal', { exitCode: null, signal: 'SIGKILL' }, 'No stderr output'],
      ['with plain stdout', { exitCode: 1, stdout: 'some context' }, 'No stderr output'],
    ])('is a non-blocking error %s, and adds no context', (_name, extra, stderr) => {
      expect(read('UserPromptSubmit', extra)).toEqual({
        error: `Failed with non-blocking status code: ${stderr}`,
      });
    });

    it('lets valid JSON decide and reports no error', () => {
      const context = { hookEventName: 'PostToolUse', additionalContext: 'Generated file' };
      const json = { systemMessage: 'Careful', hookSpecificOutput: context };
      expect(read('PostToolUse', { exitCode: 3, stderr: 'boom', json })).toEqual({
        systemMessage: 'Careful',
        hookSpecificOutput: context,
      });
    });

    it.each([1, 3, 127, null])(
      'fails the worktree events, and only those, on exit %s whatever stdout holds',
      (exitCode) => {
        const failure = { exitCode, stderr: 'no disk', stdout: '/tmp/worktree' };
        expect(eventsWith('block', failure)).toEqual(['WorktreeCreate', 'WorktreeRemove']);
        expect(read('WorktreeRemove', failure)).toEqual({
          block: { reason: '[check.sh]: no disk' },
        });
      },
    );

    it('is not reported on an event that ignores the exit code', () => {
      const ignored: HookEvent[] = ['StopFailure', 'PermissionDenied', 'Notification', 'Setup'];
      expect(ignored.map((event) => read(event, { exitCode: 1, stderr: 'boom' }))).toEqual([
        {},
        {},
        {},
        {},
      ]);
      expect(read('PermissionRequest', { exitCode: 1, stderr: 'boom' })).toEqual({
        error: 'Failed with non-blocking status code: boom',
      });
    });
  });

  describe('a hook that did not finish', () => {
    it('is a non-blocking error when it could not start', () => {
      expect(read('PreToolUse', { exitCode: null, startError: 'spawn lint-all ENOENT' })).toEqual({
        error: 'Failed to run: spawn lint-all ENOENT',
      });
    });

    it('discards the output of a hook that timed out, and blocks only a model switch', () => {
      const late = { timedOut: true, json: { decision: 'block', reason: 'too late' } };
      expect(read('PreToolUse', late)).toEqual({ error: 'Timed out; its output was discarded' });
      expect(read('UserPromptSubmit', late)).toEqual({
        error: 'Timed out; its output was discarded',
      });
      expect(eventsWith('block', { timedOut: true })).toEqual([
        'PreModelSwitch',
        'WorktreeCreate',
        'WorktreeRemove',
      ]);
    });

    it('blocks only the worktree events when the hook cannot start', () => {
      const failure = { exitCode: null, startError: 'spawn ENOENT' };
      expect(eventsWith('block', failure)).toEqual(['WorktreeCreate', 'WorktreeRemove']);
      expect(read('WorktreeCreate', failure)).toEqual({
        block: { reason: 'Failed to run: spawn ENOENT' },
      });
      expect(read('PreModelSwitch', failure)).toEqual({ error: 'Failed to run: spawn ENOENT' });
    });

    it.each<[string, Given]>([
      ['could not start', { exitCode: null, startError: 'spawn ENOENT' }],
      ['timed out', { timedOut: true }],
      ['printed broken JSON', { stdout: '{"continue": }' }],
      ['printed more than can be read', { stdoutTruncated: true, stdout: '{' }],
    ])('is not reported on the events that ignore failures when it %s', (_name, given) => {
      const ignoring = HOOK_EVENTS.filter((event) => IGNORES_FAILURE.includes(event));
      expect(ignoring.map((event) => read(event, given))).toEqual(IGNORES_FAILURE.map(() => ({})));
    });
  });

  describe('JSON or plain text', () => {
    it.each<[string, string]>([
      ['several JSON lines that set no output field', '{"a":1}\n{"b":2}'],
      ['lines whose keys only look inherited', '{"constructor":1}\n{"toString":2}'],
      ['a JSON array', '["x"]'],
      ['a quoted JSON string', '"x"'],
      ['an object followed by other text', '{"continue":true} done'],
    ])('reads %s as plain text', (_name, stdout) => {
      expect(read('UserPromptSubmit', { stdout })).toEqual({ context: stdout });
    });

    it.each<[string, string]>([
      ['a broken object', '{"continue": }'],
      ['several JSON lines of which one sets an output field', '{"a":1}\n{"continue":true}'],
      ['one valid line and one broken line', '{"a":1}\n{b}'],
    ])('reports %s as a parse failure and adds no context', (_name, stdout) => {
      const reading = read('UserPromptSubmit', { stdout });
      expect(reading).toEqual({ error: expect.stringContaining('is not valid JSON — ') });
      expect(read('UserPromptSubmit', { stdout, exitCode: 1, stderr: 'boom' })).toEqual(reading);
    });

    it('reads an object surrounded by whitespace as JSON', () => {
      expect(read('Stop', { stdout: ' \n{"systemMessage":"Done"}\n ' })).toEqual({
        systemMessage: 'Done',
      });
    });
  });

  describe('the output schema', () => {
    it.each<[string, HookEvent, object, string]>([
      ['a common field of the wrong type', 'Stop', { continue: 'no' }, 'continue: '],
      ['a decision that is not approve or block', 'Stop', { decision: 'deny' }, 'decision: '],
      [
        'an event field of the wrong type',
        'PostToolUse',
        { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 123 } },
        'hookSpecificOutput.additionalContext: ',
      ],
      [
        'a hookSpecificOutput with no event name',
        'Stop',
        { hookSpecificOutput: { additionalContext: 'x' } },
        'hookSpecificOutput.hookEventName: ',
      ],
      [
        'a hookSpecificOutput on an event that has none',
        'TaskCreated',
        { hookSpecificOutput: { hookEventName: 'TaskCreated' } },
        'hookSpecificOutput.hookEventName: ',
      ],
      [
        'a permission request with no decision',
        'PermissionRequest',
        { hookSpecificOutput: { hookEventName: 'PermissionRequest' } },
        'hookSpecificOutput.decision: ',
      ],
      [
        'a permission update to an unknown place',
        'PermissionRequest',
        {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: {
              behavior: 'allow',
              updatedPermissions: [{ type: 'setMode', mode: 'plan', destination: 'everywhere' }],
            },
          },
        },
        'hookSpecificOutput.decision.updatedPermissions.0.destination: ',
      ],
    ])('reports %s as a non-blocking error', (_name, event, json, issue) => {
      const reading = read(event, { json });
      expect(reading).toEqual({ error: expect.stringContaining(issue) });
      expect(reading.error).toMatch(/^Hook JSON output validation failed — /);
    });

    it('reports a hookSpecificOutput that names another event as Claude does', () => {
      expect(
        read('Stop', { json: { hookSpecificOutput: { hookEventName: 'SubagentStop' } } }),
      ).toEqual({
        error:
          "Failed to run: Hook returned incorrect event name: expected 'Stop' but got 'SubagentStop'",
      });
    });

    it('lists the first five issues of one output and counts the rest', () => {
      expect(read('Stop', { json: { continue: 'no', stopReason: 1 } }).error).toMatch(
        /— continue: .+\n {2}- stopReason: [^\n]+$/,
      );
      const watchPaths = Array.from({ length: 1000 }, () => 1);
      const json = { hookSpecificOutput: { hookEventName: 'CwdChanged', watchPaths } };
      const error = read('CwdChanged', { json }).error ?? '';
      expect(error.split('\n  - ')).toHaveLength(6);
      expect(error).toMatch(
        /^Hook JSON output validation failed — hookSpecificOutput\.watchPaths\.0: /,
      );
      expect(error).toMatch(/\n {2}- and 995 more$/);
    });

    it('rejects a list longer than any hook needs in one step', () => {
      const watchPaths = Array.from({ length: 10_001 }, () => '/tmp/a');
      const json = { hookSpecificOutput: { hookEventName: 'CwdChanged', watchPaths } };
      expect(read('CwdChanged', { json }).error).toBe(
        'Hook JSON output validation failed — hookSpecificOutput.watchPaths: has more than 10000 entries',
      );
      const atLimit = { ...json.hookSpecificOutput, watchPaths: watchPaths.slice(1) };
      expect(read('CwdChanged', { json: { hookSpecificOutput: atLimit } }).error).toBeUndefined();
    });

    it('drops unknown keys instead of failing', () => {
      const json = {
        note: 'x',
        hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'Run tests', extra: 1 },
      };
      expect(read('Stop', { json })).toEqual({
        hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'Run tests' },
      });
      const named = { hookEventName: 'PermissionRequest' };
      const deny = { behavior: 'deny', message: 'No' };
      const noted = { hookSpecificOutput: { ...named, decision: { ...deny, note: 1 } } };
      expect(read('PermissionRequest', { json: noted })).toEqual({
        hookSpecificOutput: { ...named, decision: deny },
      });
      const update = { type: 'addRules', rules: [], behavior: 'deny', destination: 'session' };
      const allow = { behavior: 'allow', updatedPermissions: [update] };
      const allowed = { hookSpecificOutput: { ...named, decision: allow } };
      expect(read('PermissionRequest', { json: allowed })).toEqual(allowed);
    });
  });

  describe('decisions', () => {
    it.each(['allow', 'deny', 'ask', 'defer'])(
      'reports a PreToolUse "%s" as written',
      (decision) => {
        const hookSpecificOutput = {
          hookEventName: 'PreToolUse',
          permissionDecision: decision,
          permissionDecisionReason: 'Because',
          updatedInput: { command: 'npm test --silent' },
          additionalContext: 'Target is production',
        };
        expect(read('PreToolUse', { json: { hookSpecificOutput } })).toEqual({
          hookSpecificOutput,
          ...(decision === 'deny' && { block: { reason: 'Because' } }),
        });
      },
    );

    it.each<[string, object, object, string?]>([
      [
        'approve to allow',
        { decision: 'approve', reason: 'Safe' },
        { permissionDecision: 'allow', permissionDecisionReason: 'Safe' },
      ],
      [
        'block to deny',
        { decision: 'block', reason: 'Unsafe' },
        { permissionDecision: 'deny', permissionDecisionReason: 'Unsafe' },
        'Unsafe',
      ],
      [
        'block with no reason to deny',
        { decision: 'block' },
        { permissionDecision: 'deny' },
        'Blocked by hook',
      ],
    ])('maps the deprecated PreToolUse decision %s', (_name, json, specific, reason) => {
      expect(read('PreToolUse', { json })).toEqual({
        hookSpecificOutput: { hookEventName: 'PreToolUse', ...specific },
        ...(reason && { block: { reason } }),
      });
    });

    it.each<[string, object, string]>([
      ['the top-level reason when the deny gives none', {}, 'Top'],
      ['its own reason over the top-level one', { permissionDecisionReason: 'Own' }, 'Own'],
    ])('takes a deny reason from %s', (_name, own, reason) => {
      const deny = { hookEventName: 'PreToolUse', permissionDecision: 'deny', ...own };
      const json = { reason: 'Top', hookSpecificOutput: deny };
      expect(read('PreToolUse', { json })).toEqual({ hookSpecificOutput: deny, block: { reason } });
    });

    it('prefers the newer reason to the reason of a deprecated decision', () => {
      const allow = { permissionDecision: 'allow', permissionDecisionReason: 'Own' };
      const json = {
        decision: 'block',
        reason: 'Top',
        hookSpecificOutput: { hookEventName: 'PreToolUse', ...allow },
      };
      expect(read('PreToolUse', { json })).toEqual({
        hookSpecificOutput: { hookEventName: 'PreToolUse', ...allow },
        block: { reason: 'Top' },
      });
    });

    it('keeps the block of a deprecated decision next to a newer allow, written as given', () => {
      const allow = { hookEventName: 'PreToolUse', permissionDecision: 'allow' };
      const json = { decision: 'block', reason: 'Unsafe', hookSpecificOutput: allow };
      expect(read('PreToolUse', { json })).toEqual({
        hookSpecificOutput: allow,
        block: { reason: 'Unsafe' },
      });
    });

    it('blocks on a top-level decision only where the reference gives it one', () => {
      const json = { decision: 'block', reason: 'Tests are failing' };
      expect(eventsWith('block', { json })).toEqual(TOP_LEVEL_BLOCK);
      expect(read('Stop', { json }).block).toEqual({ reason: 'Tests are failing' });
      expect(read('Stop', { json: { decision: 'block' } }).block).toEqual({
        reason: 'Blocked by hook',
      });
      expect(read('Stop', { json: { decision: 'approve' } })).toEqual({});
    });

    it('reads every kind of permission update, and manual as the default mode', () => {
      const rules = [{ toolName: 'Bash' }, { toolName: 'Edit', ruleContent: '*.ts' }];
      const modes = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'];
      const destination = 'session';
      const destinations = [
        'userSettings',
        'projectSettings',
        'localSettings',
        'session',
        'cliArg',
      ];
      const updates = [
        ...['addRules', 'replaceRules', 'removeRules'].flatMap((type) =>
          ['allow', 'deny', 'ask'].map((behavior) => ({ type, rules, behavior, destination })),
        ),
        ...destinations.map((place) => ({ type: 'setMode', mode: 'plan', destination: place })),
        ...modes.map((mode) => ({ type: 'setMode', mode, destination })),
        ...['addDirectories', 'removeDirectories'].map((type) => ({
          type,
          directories: ['/tmp/out'],
          destination,
        })),
      ];
      const request = (updatedPermissions: object[]) => ({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow', updatedPermissions },
        },
      });
      expect(read('PermissionRequest', { json: request(updates) })).toEqual(request(updates));
      const manual = { type: 'setMode', mode: 'manual', destination };
      expect(read('PermissionRequest', { json: request([manual]) })).toEqual(
        request([{ ...manual, mode: 'default' }]),
      );
    });

    it('blocks a model switch on deny and reports ask as written', () => {
      const deny = {
        hookEventName: 'PreModelSwitch',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Too costly',
      };
      expect(read('PreModelSwitch', { json: { hookSpecificOutput: deny } })).toEqual({
        hookSpecificOutput: deny,
        block: { reason: 'Too costly' },
      });
      const ask = { hookEventName: 'PreModelSwitch', permissionDecision: 'ask' };
      expect(read('PreModelSwitch', { json: { hookSpecificOutput: ask } })).toEqual({
        hookSpecificOutput: ask,
      });
    });

    it.each<[HookEvent, object]>([
      [
        'PermissionRequest',
        {
          decision: {
            behavior: 'allow',
            updatedInput: { command: 'npm run lint' },
            updatedPermissions: [
              {
                type: 'addRules',
                rules: [{ toolName: 'Bash', ruleContent: 'npm run lint' }],
                behavior: 'allow',
                destination: 'session',
              },
              { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
              { type: 'addDirectories', directories: ['/tmp/out'], destination: 'localSettings' },
            ],
          },
        },
      ],
      ['PermissionDenied', { retry: true }],
      ['PermissionDenied', { retry: false }],
      [
        'UserPromptSubmit',
        { additionalContext: 'a', sessionTitle: 'b', suppressOriginalPrompt: true },
      ],
      ['UserPromptExpansion', { additionalContext: 'a', suppressOriginalPrompt: true }],
      [
        'SessionStart',
        {
          additionalContext: 'a',
          initialUserMessage: 'b',
          sessionTitle: 'c',
          watchPaths: ['/tmp/.envrc'],
          reloadSkills: true,
        },
      ],
      [
        'PostToolUse',
        {
          additionalContext: 'a',
          classifierContext: 'b',
          updatedToolOutput: { stdout: 'redacted' },
          updatedMCPToolOutput: 'redacted',
        },
      ],
      ['PostToolUseFailure', { additionalContext: 'a' }],
      ['PostToolBatch', { additionalContext: 'a' }],
      ['Stop', { additionalContext: 'a' }],
      ['SubagentStart', { additionalContext: 'a' }],
      ['SubagentStop', { additionalContext: 'a' }],
      ['PostModelSwitch', { additionalContext: 'a' }],
      ['Notification', { additionalContext: 'a' }],
      ['ElicitationResult', { action: 'decline', content: { name: 'a' } }],
      ['Elicitation', { action: 'cancel' }],
      ['CwdChanged', { watchPaths: [] }],
      ['FileChanged', { watchPaths: ['/tmp/.env'] }],
      ['MessageDisplay', { displayContent: 'shown instead' }],
    ])('reports the documented fields of %s', (event, fields) => {
      const hookSpecificOutput = { hookEventName: event, ...fields };
      expect(read(event, { json: { hookSpecificOutput } })).toEqual({ hookSpecificOutput });
    });

    it('shows the original message text when a MessageDisplay hook exits 2', () => {
      const hookSpecificOutput = { hookEventName: 'MessageDisplay', displayContent: 'replaced' };
      const given = { json: { hookSpecificOutput }, exitCode: 2, stderr: 'no\n' };
      expect(read('MessageDisplay', given)).toEqual({});
    });
  });

  describe('common fields', () => {
    const reported = {
      continue: false,
      stopReason: 'Build failed',
      suppressOutput: true,
      systemMessage: 'Check the build',
    };
    const json = { ...reported, terminalSequence: '\u0007' };

    it('reports them where the event honours them, and never the terminal sequence', () => {
      expect(read('PreToolUse', { json })).toEqual(reported);
      expect(read('TeammateIdle', { json })).toEqual(reported);
    });

    it('drops the fields each event discards', () => {
      const stopped = HOOK_EVENTS.filter((event) => read(event, { json }).continue === false);
      const explained = HOOK_EVENTS.filter((event) => read(event, { json }).stopReason);
      const warned = HOOK_EVENTS.filter((event) => read(event, { json }).systemMessage);
      const unstopped = [...DROPS_COMMON_FIELDS, ...KEEPS_ONLY_SYSTEM_MESSAGE];
      expect(stopped).toEqual(HOOK_EVENTS.filter((event) => !unstopped.includes(event)));
      expect(explained).toEqual(stopped);
      expect(warned).toEqual(HOOK_EVENTS.filter((event) => !DROPS_COMMON_FIELDS.includes(event)));
    });

    it('reads nothing at all from an event that discards its output', () => {
      const broken = { stdout: '{"continue": }' };
      const silent = [...IGNORES_FAILURE, 'SessionEnd', 'WorktreeCreate', 'WorktreeRemove'];
      expect(eventsWith('error', broken)).toEqual(
        HOOK_EVENTS.filter((event) => !silent.includes(event)).sort(),
      );
      const discarding: HookEvent[] = ['SessionEnd', 'StopFailure', 'Setup', 'InstructionsLoaded'];
      expect(discarding.map((event) => read(event, { json }))).toEqual([{}, {}, {}, {}]);
      expect(discarding.map((event) => read(event, broken))).toEqual([{}, {}, {}, {}]);
      expect(read('WorktreeRemove', broken)).toEqual({});
    });
  });

  describe('the 10,000 character cap', () => {
    // The astral character sits across the cap, so a cut there would split it.
    const atCap = 'a'.repeat(10_000);
    const overCap = `${'a'.repeat(9_999)}\u{1F600}`;

    it('keeps a text of exactly the cap and marks a longer one, passed on whole', () => {
      const context = (additionalContext: string) => ({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext },
      });
      expect(read('PostToolUse', { json: context(atCap) })).toEqual(context(atCap));
      expect(read('PostToolUse', { json: context(overCap) })).toEqual({
        ...context(overCap),
        overCap: ['additionalContext'],
      });
    });

    it('measures plain stdout and each JSON text on its own', () => {
      expect(read('SessionStart', { stdout: atCap })).toEqual({ context: atCap });
      expect(read('SessionStart', { stdout: overCap })).toEqual({
        context: overCap,
        overCap: ['context'],
      });
      const start = { hookEventName: 'SessionStart', additionalContext: 'short' };
      const json = {
        systemMessage: overCap,
        hookSpecificOutput: { ...start, initialUserMessage: overCap },
      };
      expect(read('SessionStart', { json }).overCap).toEqual([
        'systemMessage',
        'initialUserMessage',
      ]);
    });
  });

  describe('a background answer', () => {
    it.each<[string, string, object]>([
      ['alone', '{"async":true}', {}],
      ['with a timeout', '{"async":true,"asyncTimeout":30}', { asyncTimeout: 30 }],
      ['with a timeout that is not a number', '{"async":true,"asyncTimeout":"x"}', {}],
      [
        'with a nested value',
        '{"async":true,"asyncTimeout":30,"meta":{"k":1}}',
        { asyncTimeout: 30 },
      ],
      ['printed over several lines', '{\n  "async": true,\n  "meta": { "k": 1 }\n}', {}],
      ['on the first line, before later output', '{"async": true}\n{"decision":"block"}', {}],
    ])('is reported as such and nothing else is read: %s', (_name, stdout, async) => {
      expect(read('Stop', { stdout })).toEqual({ async });
    });

    it('is a non-blocking error when the hook then fails', () => {
      expect(read('Stop', { stdout: '{"async":true}', exitCode: 1, stderr: 'boom\n' })).toEqual({
        error: 'Announced async, then failed with status code 1: boom',
      });
    });

    it('is not read from an answer that says false, or from a later line', () => {
      expect(read('Stop', { stdout: '{"async":false}' })).toEqual({});
      expect(read('Stop', { stdout: '{\n  "async": true\n}\n{"b":2}' }).error).toMatch(
        /is not valid JSON — /,
      );
    });
  });

  describe('stdout that was cut short', () => {
    const cut = { stdoutTruncated: true, stdout: '{"decision":"block","reason":"x"}' };

    it('is never read as JSON, as context or as a path', () => {
      const error = 'The hook printed more output than can be read';
      expect(read('Stop', cut)).toEqual({ error });
      expect(read('SessionStart', { stdoutTruncated: true, stdout: 'context' })).toEqual({ error });
      expect(read('WorktreeCreate', { stdoutTruncated: true, stdout: '/tmp/wt' })).toEqual({
        block: { reason: error },
      });
      expect(read('Stop', { stdoutTruncated: true, stdout: ' \n ' })).toEqual({ error });
    });

    it('is passed over as plain text where the kept start shows it is not JSON', () => {
      const logs = { stdoutTruncated: true, stdout: 'lint: 12 files checked\n{' };
      expect(read('PreToolUse', logs)).toEqual({});
      expect(read('PreToolUse', { ...logs, exitCode: 1 })).toEqual({
        error: 'Failed with non-blocking status code: No stderr output',
      });
    });

    it('is not reported on an event that reads no output', () => {
      const events: HookEvent[] = ['SessionEnd', 'WorktreeRemove'];
      expect(events.map((event) => read(event, cut))).toEqual([{}, {}]);
    });
  });

  describe('WorktreeCreate', () => {
    it('takes the path from the last line that is not blank, without escape codes', () => {
      const stdout = 'Welcome to my shell\r\n\u001B[32m/tmp/worktrees/fix\u001B[0m \r\n\n';
      expect(read('WorktreeCreate', { stdout })).toEqual({
        hookSpecificOutput: { hookEventName: 'WorktreeCreate', worktreePath: '/tmp/worktrees/fix' },
      });
    });

    it('fails creation when the hook prints no path', () => {
      expect(read('WorktreeCreate', { stdout: ' \n' })).toEqual({
        block: { reason: 'The hook printed no worktree path' },
      });
    });
  });
});
