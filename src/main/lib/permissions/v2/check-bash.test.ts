import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateRuleString } from '../../../../shared/lib/validate-rule';
import { checkBash } from './check-bash';
import { EMPTY_DOCS } from './eval-rules';
import type { PermissionsDoc } from './types';

const root = '/home/user/project';
const noRules: PermissionsDoc = { allow: [], deny: [], ask: [] };

describe('checkBash — truth table integration', () => {
  it('policy deny overrides project allow', () => {
    const docs = {
      policy: { ...noRules, deny: ['Bash(rm:*)'] },
      project: { ...noRules, allow: ['Bash(rm:*)'] },
      user: noRules,
    };
    const r = checkBash({ command: 'rm -rf foo' }, docs, root);
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'rule:deny', tier: 'policy' } });
  });

  it('user deny overrides project allow', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(rm:*)'] },
      user: { ...noRules, deny: ['Bash(rm:*)'] },
    };
    const r = checkBash({ command: 'rm -rf foo' }, docs, root);
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'rule:deny', tier: 'user' } });
  });
});

describe('checkBash — compound severity', () => {
  it('any deny → whole deny', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(echo:*)'], deny: ['Bash(rm:*)'] },
      user: noRules,
    };
    const r = checkBash({ command: 'echo hi && rm foo' }, docs, root);
    expect(r).toMatchObject({ decision: 'deny' });
  });

  it('any ask → whole ask when no deny', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(echo:*)'] },
      user: noRules,
    };
    const r = checkBash({ command: 'echo hi && npm test' }, docs, root);
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('all allow → whole allow', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(echo:*)', 'Bash(npm test:*)'] },
      user: noRules,
    };
    const r = checkBash({ command: 'echo hi && npm test' }, docs, root);
    expect(r).toMatchObject({ decision: 'allow' });
  });

  // Critique #10: ask + later allow → still ask (escalation guard)
  it('ask in earlier sub + allow in later sub → ask', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(echo:*)'] }, // npm has no rule
      user: noRules,
    };
    const r = checkBash({ command: 'npm test && echo done' }, docs, root);
    expect(r).toMatchObject({ decision: 'ask' });
  });
});

describe('checkBash — 50-subcommand cap', () => {
  it('> 50 subcommands → ask (not deny)', () => {
    const cmd = Array(55).fill('true').join(' ; ');
    const r = checkBash({ command: cmd }, EMPTY_DOCS, root);
    expect(r).toMatchObject({ decision: 'ask', prompt: { reason: 'over-50-subcommands' } });
  });

  it('= 50 subcommands → normal eval', () => {
    const cmd = Array(50).fill('true').join(' ; ');
    const r = checkBash({ command: cmd }, EMPTY_DOCS, root);
    expect(r).toMatchObject({ decision: 'ask' });
    if (r.decision === 'ask') {
      expect(r.prompt.reason).not.toBe('over-50-subcommands');
    }
  });
});

describe('checkBash — substitution and eval-like heads ask; a prefix rule never auto-allows them', () => {
  const echoPrefixAllowed = {
    policy: noRules,
    project: { ...noRules, allow: ['Bash(echo:*)'] },
    user: noRules,
  };

  it.each(['echo `whoami`', 'echo $(whoami)'])(
    '%s asks despite Bash(echo:*) and suggests only its own exact rule',
    (command) => {
      const r = checkBash({ command }, echoPrefixAllowed, root);
      expect(r).toMatchObject({ decision: 'ask', prompt: { reason: 'no-matching-rule' } });
      if (r.decision !== 'ask') return;
      expect(r.prompt.suggestedRules).toEqual([`Bash(${command.replace(/[()]/g, '\\$&')})`]);
    },
  );

  it('the suggested exact rule allows the same command on replay', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(echo $\\(whoami\\))'] },
      user: noRules,
    };
    expect(checkBash({ command: 'echo $(whoami)' }, docs, root)).toEqual({ decision: 'allow' });
  });

  it.each(['eval foo', 'exec /bin/sh', 'source .env', '. .env', 'zmodload zsh/files'])(
    '%s asks with no Bash(head:*) suggestion',
    (command) => {
      const r = checkBash({ command }, EMPTY_DOCS, root);
      expect(r).toMatchObject({ decision: 'ask' });
      if (r.decision !== 'ask') return;
      expect(r.prompt.suggestedRules).toEqual([`Bash(${command})`]);
    },
  );

  it.each([
    ['eval "rm -rf ~"', 'Bash(eval:*)'],
    // Substitution keeps its base for exactly this reason: the old hard deny used
    // to stop these, so an explicit user deny must keep stopping them.
    ['echo $(whoami)', 'Bash(echo:*)'],
    ['echo `whoami`', 'Bash(echo:*)'],
    ['git push $BRANCH', 'Bash(git push:*)'],
  ])('%s is still denied by an explicit %s (deny rules are checked verbatim)', (command, rule) => {
    const docs = { policy: noRules, project: { ...noRules, deny: [rule] }, user: noRules };
    expect(checkBash({ command }, docs, root)).toMatchObject({
      decision: 'deny',
      reason: { kind: 'rule:deny', rule },
    });
  });

  it('a prefix ALLOW still never matches an exact-only sub', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(echo:*)'] },
      user: noRules,
    };
    expect(checkBash({ command: 'echo $(whoami)' }, docs, root)).toMatchObject({ decision: 'ask' });
  });

  it('tier-1c path containment still denies a denied path (the surviving deny tier)', () => {
    const r = checkBash({ command: 'cat ~/.ssh/id_rsa' }, EMPTY_DOCS, root);
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  it('a multi-line exact-only sub gets no exact suggestion (renderer fallback instead)', () => {
    const r = checkBash({ command: 'echo "$(cat <<EOF\nx\nEOF\n)"' }, EMPTY_DOCS, root);
    expect(r).toMatchObject({ decision: 'ask' });
    if (r.decision !== 'ask') return;
    expect(r.prompt.suggestedRules).toEqual([]);
  });
});

describe('checkBash — the exact rule offered for an exact-only sub is one a user can actually keep', () => {
  const suggestionsFor = (command: string, docs = EMPTY_DOCS): string[] => {
    const r = checkBash({ command }, docs, root);
    expect(r.decision).toBe('ask');
    return r.decision === 'ask' ? (r.prompt.suggestedRules ?? []) : [];
  };

  const allowing = (rules: string[]) => ({
    policy: noRules,
    project: { ...noRules, allow: rules },
    user: noRules,
  });

  it.each([
    ['command substitution', 'echo $(whoami)'],
    ['eval-like head', 'eval "rm -rf ~"'],
    ['named expansion', 'cat "$HOME/notes.md"'],
    // Windows-native argument: backslashes are not rule-grammar escapes, so the
    // rule must still round-trip byte-for-byte.
    ['windows path with backslashes', 'cat C:\\Users\\me\\notes.txt $TAIL'],
  ])('%s: every offered rule is valid and re-allows the same command', (_name, command) => {
    const offered = suggestionsFor(command);
    expect(offered.length).toBeGreaterThan(0);
    for (const rule of offered) {
      // Persistence runs the same validator, so an invalid rule would be dropped
      // after the user clicked Allow always.
      expect(validateRuleString(rule, 'allow')).toMatchObject({ ok: true });
    }
    expect(checkBash({ command }, allowing(offered), root)).toEqual({ decision: 'allow' });
  });

  it('offers each rule once when a command repeats the same exact-only sub', () => {
    const offered = suggestionsFor('echo $A && echo $A');
    expect(offered).toEqual(['Bash(echo $A)']);
  });

  it('offers one rule per distinct exact-only sub', () => {
    expect(suggestionsFor('echo $A && cat $B')).toEqual(['Bash(echo $A)', 'Bash(cat $B)']);
  });

  it.each(['echo "$X":*', 'echo $X *'])(
    'offers nothing for %s, whose text ends in the grammar wildcard shape',
    (command) => {
      // Such a rule parses as a PREFIX rule, which exactMatchRules then strips for
      // an exact-only sub, so Allow-always could never re-allow the command.
      expect(suggestionsFor(command)).toEqual([]);
    },
  );

  it('offers nothing rather than a rule that cannot round-trip through the grammar', () => {
    // An escaped paren in the command collides with the grammar's own paren
    // escape, so the parsed content would not equal the command it came from.
    expect(suggestionsFor("grep '\\(foo\\)' $FILE")).toEqual([]);
  });

  it('offers nothing for a metachar-hidden directory, whose signature is a truncated form', () => {
    // A second arg truncates the signature to `cat -v`, so no whole-command rule
    // could ever match it. Offer none rather than one that cannot work.
    expect(suggestionsFor('cat -v ~/.c*fig/gcloud/creds extra')).toEqual([]);
    // And a prefix rule still never auto-allows it.
    expect(
      checkBash({ command: 'cat -v ~/.c*fig/gcloud/creds extra' }, allowing(['Bash(cat:*)']), root),
    ).toMatchObject({ decision: 'ask' });
  });

  it('SECURITY: a subcommand hidden behind a single-quoted backslash is still rule-checked', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, deny: ['Bash(rm:*)'] },
      user: noRules,
    };
    const r = checkBash({ command: "echo 'a\\' && rm -rf /" }, docs, root);
    expect(r).toMatchObject({
      decision: 'deny',
      reason: { kind: 'rule:deny', rule: 'Bash(rm:*)' },
    });
  });
});

describe('checkBash — bash-Read parity (system-denied paths)', () => {
  it('cat /project/.env deny via parity even with Bash(cat:*) allow', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(cat:*)'] },
      user: noRules,
    };
    const r = checkBash({ command: 'cat /home/user/project/.env' }, docs, root);
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  // Bare relative arg: resolves under projectRoot, so no directory glob can fire and only the
  // basename branch can deny it. The ~/.ssh/* cases below would still pass with the basename
  // patterns deleted, because `**/.ssh/**` catches them — this is the one that pins the glob.
  it('bare relative id_rsa deny via basename glob even with Bash(cat:*) allow', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(cat:*)'] },
      user: noRules,
    };
    const r = checkBash({ command: 'cat id_rsa' }, docs, root);
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  it('cp key.pem ~/.ssh/id_rsa deny via parity', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(cp:*)'] },
      user: noRules,
    };
    const r = checkBash({ command: 'cp key.pem ~/.ssh/id_rsa' }, docs, root);
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  it('mkdir ~/.ssh/evil deny via parity (mkdir is write-ish)', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(mkdir:*)'] },
      user: noRules,
    };
    const r = checkBash({ command: 'mkdir -p ~/.ssh/evil' }, docs, root);
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  it('input redirect < ~/.ssh/id_rsa deny via parity', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(wc:*)'] },
      user: noRules,
    };
    const r = checkBash({ command: 'wc -l < ~/.ssh/id_rsa' }, docs, root);
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  it('echo > ~/.ssh/authorized_keys deny via redirection check', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(echo:*)'] },
      user: noRules,
    };
    const r = checkBash({ command: 'echo pwned > ~/.ssh/authorized_keys' }, docs, root);
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  it('python -c (exotic command, out of scope per ticket §38) NOT denied via parity', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(python:*)'] },
      user: noRules,
    };
    // Plain command (no expansion, no redirect) — falls through to rule allow.
    const r = checkBash({ command: 'python script.py' }, docs, root);
    expect(r).toMatchObject({ decision: 'allow' });
  });

  // shell-quote hands back {op:'glob'} rather than a string for an unquoted
  // glob. Filtering tokens to strings dropped it, so the shell expanded a
  // pattern the checker had extracted zero paths from.
  // A metachar hiding a DIRECTORY erases the segment the denied list matches on,
  // so the tier-1c kill switch cannot evaluate it. The pipeline must not
  // auto-allow such a path under a prefix rule — it asks instead, the same
  // treatment `$VAR` gets. A hard deny would refuse `grep foo src/*​/x.ts` too.
  it.each(['cat ~/.c*fig/gcloud/creds', 'cat ~/.{config,x}/gcloud/creds', 'cat ~/.ss?/id_rsa'])(
    'metachar-hidden directory %j is not auto-allowed by a prefix rule',
    (command) => {
      const docs = {
        policy: noRules,
        project: { ...noRules, allow: ['Bash(cat:*)'] },
        user: noRules,
      };
      expect(checkBash({ command }, docs, root).decision).not.toBe('allow');
    },
  );

  it('a literal directory under a prefix rule still allows', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(cat:*)'] },
      user: noRules,
    };
    expect(checkBash({ command: 'cat src/app/index.ts' }, docs, root)).toEqual({
      decision: 'allow',
    });
  });

  it.each(['cat ~/.ssh/*', 'cat ~/.aws/*'])('glob argument %j denied via parity', (command) => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(cat:*)'] },
      user: noRules,
    };
    expect(checkBash({ command }, docs, root)).toMatchObject({
      decision: 'deny',
      reason: { kind: 'safety:path' },
    });
  });

  it.each([
    'strings ~/.ssh/id_rsa',
    'sort ~/.aws/credentials',
    'sha256sum ~/.ssh/id_rsa',
    'nl ~/.ssh/id_rsa',
    // tac is the command Claude Code's parallel lists left auto-allowed; rev and
    // base64 are macOS base-install. All emit contents, so all are cat-equivalent.
    'tac ~/.ssh/id_rsa',
    'rev ~/.ssh/id_rsa',
    'base64 ~/.ssh/id_rsa',
    'zcat ~/.ssh/id_rsa',
    'expand ~/.ssh/id_rsa',
    'pr ~/.ssh/id_rsa',
    'shuf ~/.ssh/id_rsa',
  ])('content-leaking command %j denied via parity', (command) => {
    const docs = {
      policy: noRules,
      project: {
        ...noRules,
        allow: [
          'Bash(strings:*)',
          'Bash(sort:*)',
          'Bash(sha256sum:*)',
          'Bash(nl:*)',
          'Bash(tac:*)',
          'Bash(rev:*)',
          'Bash(base64:*)',
          'Bash(zcat:*)',
          'Bash(expand:*)',
          'Bash(pr:*)',
          'Bash(shuf:*)',
        ],
      },
      user: noRules,
    };
    expect(checkBash({ command }, docs, root)).toMatchObject({
      decision: 'deny',
      reason: { kind: 'safety:path' },
    });
  });
});

// grep-family arguments are mostly SEARCH PATTERNS. "Skip the first non-flag
// arg" would eat the value of any value-taking flag and then read the pattern as
// a path, hard-denying ordinary code search at tier-1c with no way to approve.
// Only path-shaped tokens are checked instead.
describe('checkBash — grep-family patterns are not paths', () => {
  const grepDocs = {
    policy: noRules,
    project: { ...noRules, allow: ['Bash(grep:*)', 'Bash(rg:*)'] },
    user: noRules,
  };

  // Project scope only. Read-only checks every argument instead, because a bare
  // filename in second position IS a path and nothing can tell it from a
  // pattern — see the read-only suite. Here a rule tier follows, so denying an
  // ordinary code search at tier-1c would be unappealable.
  it.each([
    'grep .env config.txt',
    'grep -C 3 .env README.md',
    'grep -m 1 .env config.txt',
    'grep -A 3 secrets.txt file.log',
    'grep -e foo -e id_rsa file.log',
    'rg --glob *.ts id_rsa src',
    'rg -m 1 id_rsa scripts/',
  ])('searching for a secret-shaped literal is allowed: %j', (command) => {
    expect(checkBash({ command }, grepDocs, root)).toEqual({ decision: 'allow' });
  });

  it('a path-shaped grep target is still denied', () => {
    expect(checkBash({ command: 'grep secret ~/.ssh/id_rsa' }, grepDocs, root)).toMatchObject({
      decision: 'deny',
      reason: { kind: 'safety:path' },
    });
  });
});

describe('checkBash — non-path positional args of widened read commands', () => {
  it.each([
    'tr a b',
    'sort -k 2 data.csv',
    'cut -d, -f1 x.csv',
    'fold -w 80 f.txt',
    'column -t',
    'comm f1 f2',
    'join f1 f2',
    'paste f1 f2',
    'nl file',
    'diff a.txt b.txt',
  ])('%j is not mistaken for a denied path', (command) => {
    const base = command.split(' ')[0];
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: [`Bash(${base}:*)`] },
      user: noRules,
    };
    expect(checkBash({ command }, docs, root)).toEqual({ decision: 'allow' });
  });
});

// A bare newline separates commands in bash. shell-quote flattens it to
// whitespace, so before splitRaw handled it this collapsed into ONE subcommand
// signed `git status` — and the most benign rule a user can grant auto-approved
// whatever followed, with no permission card.
describe('checkBash — newline is a command separator', () => {
  it.each([
    ['git status\nrm -rf ~/work', 'Bash(git status:*)'],
    ['ls -la\nrm -rf ~/work', 'Bash(ls:*)'],
    ['ls -la\rrm -rf ~/work', 'Bash(ls:*)'],
  ])('%j does not auto-allow under %s', (command, rule) => {
    const docs = { policy: noRules, project: { ...noRules, allow: [rule] }, user: noRules };
    expect(checkBash({ command }, docs, root).decision).not.toBe('allow');
  });

  it('a backslash line continuation stays one command', () => {
    const docs = { policy: noRules, project: { ...noRules, allow: ['Bash(ls:*)'] }, user: noRules };
    expect(checkBash({ command: 'ls -la \\\n  src' }, docs, root)).toEqual({ decision: 'allow' });
  });
});

describe('checkBash — redirection fd-dups not treated as paths', () => {
  it('npm test 2>&1 → no spurious safety:path (with rule allow)', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(npm test:*)'] },
      user: noRules,
    };
    const r = checkBash({ command: 'npm test 2>&1' }, docs, root);
    expect(r).toMatchObject({ decision: 'allow' });
  });

  it('cmd >&2 → no spurious safety:path', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(echo:*)'] },
      user: noRules,
    };
    const r = checkBash({ command: 'echo hi >&2' }, docs, root);
    expect(r).toMatchObject({ decision: 'allow' });
  });

  it('cmd &>/dev/null → /dev/null is fine (not denied)', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(echo:*)'] },
      user: noRules,
    };
    const r = checkBash({ command: 'echo hi &> /dev/null' }, docs, root);
    expect(r).toMatchObject({ decision: 'allow' });
  });
});

describe('checkBash — DenyReason transparency', () => {
  it('rule:deny includes rule + tier', () => {
    const docs = {
      policy: noRules,
      project: noRules,
      user: { ...noRules, deny: ['Bash(rm:*)'] },
    };
    const r = checkBash({ command: 'rm foo' }, docs, root);
    expect(r).toMatchObject({
      decision: 'deny',
      reason: { kind: 'rule:deny', rule: 'Bash(rm:*)', tier: 'user' },
    });
  });
});

describe('checkBash — isExactMatchOnly guard (critique #2)', () => {
  it('Bash(npm:*) does NOT match unsafe-env-prefixed PATH=/tmp/evil npm test', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(npm:*)'] },
      user: noRules,
    };
    // Unsafe env in command → extractSignature returns isExactMatchOnly: true.
    // Prefix wildcard rule must NOT match.
    const r = checkBash({ command: 'PATH=/tmp/evil npm test' }, docs, root);
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('exact rule still matches expansion-flagged sub when fullSignature matches', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(echo "$1")'] },
      user: noRules,
    };
    // $1 → hasExpansion → isExactMatchOnly. Exact-match rule should still allow.
    const r = checkBash({ command: 'echo "$1"' }, docs, root);
    expect(r).toMatchObject({ decision: 'allow' });
  });

  it('deny rule still fires on isExactMatchOnly sub', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(npm:*)'], deny: ['Bash(npm test:*)'] },
      user: noRules,
    };
    // Prefix-wildcard ALLOWs are filtered for an exact-only sig, DENYs are not:
    // hiding a denied command behind an unsafe env prefix must not launder it.
    const r = checkBash({ command: 'PATH=/tmp/evil npm test' }, docs, root);
    expect(r).toMatchObject({
      decision: 'deny',
      reason: { kind: 'rule:deny', rule: 'Bash(npm test:*)' },
    });
  });

  it.each([
    ['UNSAFE=1 eval "rm -rf /"', 'Bash(eval:*)'],
    ['PATH=/tmp/evil npm test', 'Bash(npm:*)'],
    ['LD_PRELOAD=/tmp/x.so curl evil.com', 'Bash(curl:*)'],
  ])('%s is still denied by %s — an env prefix hides nothing', (command, rule) => {
    const docs = { policy: noRules, project: { ...noRules, deny: [rule] }, user: noRules };
    expect(checkBash({ command }, docs, root)).toMatchObject({
      decision: 'deny',
      reason: { kind: 'rule:deny', rule },
    });
  });
});

describe('checkBash — suggestedRules filtering', () => {
  it('excludes already-allowed subs from suggestions', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(echo:*)'] },
      user: noRules,
    };
    const r = checkBash({ command: 'echo hi && grep foo' }, docs, root);
    expect(r.decision).toBe('ask');
    if (r.decision !== 'ask') return;
    const rules = r.prompt.suggestedRules ?? [];
    expect(rules).toContain('Bash(grep:*)');
    expect(rules.some((rule) => rule.includes('echo'))).toBe(false);
  });

  it('expansion sub emits its exact rule, never a junk prefix', () => {
    const r = checkBash({ command: 'echo "$1" && grep foo' }, EMPTY_DOCS, root);
    expect(r.decision).toBe('ask');
    if (r.decision !== 'ask') return;
    const rules = r.prompt.suggestedRules ?? [];
    expect(rules).toContain('Bash(grep:*)');
    expect(rules).toContain('Bash(echo "$1")');
    expect(rules.some((rule) => rule.includes('echo') && rule.endsWith(':*)'))).toBe(false);
  });

  it('deduplicates repeated base across subs', () => {
    const r = checkBash({ command: 'grep foo && grep bar' }, EMPTY_DOCS, root);
    expect(r.decision).toBe('ask');
    if (r.decision !== 'ask') return;
    const rules = r.prompt.suggestedRules ?? [];
    expect(rules.filter((rule) => rule === 'Bash(grep:*)')).toHaveLength(1);
  });

  it('suggests only the exact rule when the sole ask-sub is empty-base', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(echo:*)'] },
      user: noRules,
    };
    // echo hi → allow; cat "$1" → expansion (base '') → ask with its exact rule.
    const r = checkBash({ command: 'echo hi && cat "$1"' }, docs, root);
    expect(r.decision).toBe('ask');
    if (r.decision !== 'ask') return;
    expect(r.prompt.suggestedRules).toEqual(['Bash(cat "$1")']);
  });

  it('deny in a later sub short-circuits even after an earlier ask was collected', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, deny: ['Bash(rm:*)'] },
      user: noRules,
    };
    const r = checkBash({ command: 'npm test && rm foo' }, docs, root);
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'rule:deny' } });
  });

  it('over-50 cap still yields well-formed suggestions', () => {
    const cmd = Array(55).fill('true').join(' ; ');
    const r = checkBash({ command: cmd }, EMPTY_DOCS, root);
    expect(r.decision).toBe('ask');
    if (r.decision !== 'ask') return;
    const rules = r.prompt.suggestedRules ?? [];
    expect(rules).toContain('Bash(true:*)');
    for (const rule of rules) expect(rule).toMatch(/^Bash\(.+:\*\)$/);
  });
});

describe('checkBash — heredoc allow-listing', () => {
  const heredoc = (path: string, body: string) => `cat > ${path} << 'EOF'\n${body}\nEOF`;

  it('well-formed heredoc → ask suggesting Bash(cat:*) (not the whole body)', () => {
    const r = checkBash({ command: heredoc('/tmp/a.json', '{"x":1}') }, EMPTY_DOCS, root);
    expect(r.decision).toBe('ask');
    if (r.decision !== 'ask') return;
    expect(r.prompt.suggestedRules).toContain('Bash(cat:*)');
  });

  it('round-trip: a persisted Bash(cat:*) allows a DIFFERENT heredoc body', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(cat:*)'] },
      user: noRules,
    };
    const r = checkBash({ command: heredoc('/tmp/b.json', '{"y":2}') }, docs, root);
    expect(r).toMatchObject({ decision: 'allow' });
  });

  it('heredoc body containing ;/| does not spawn a phantom ask', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(cat:*)'] },
      user: noRules,
    };
    const r = checkBash({ command: heredoc('/tmp/c.json', '{ a:1; b:2 | 3 }') }, docs, root);
    expect(r).toMatchObject({ decision: 'allow' });
  });

  it('heredoc writing a denied path is still blocked despite Bash(cat:*)', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(cat:*)'] },
      user: noRules,
    };
    const r = checkBash({ command: heredoc('/home/user/project/.env', 'SECRET=1') }, docs, root);
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });
});

describe('checkBash — safe heredoc substitution (commit idiom)', () => {
  /** Claude Code's canonical multi-line commit idiom (BashTool prompt). */
  const CANONICAL_COMMIT = `git commit -m "$(cat <<'EOF'
fix: subject line

body line
EOF
)" 2>&1 | tail -25; echo "---exit: $?---"`;

  it('canonical commit is NOT denied; prefix rules cover commit + tail; $? echo asks', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(git commit:*)', 'Bash(tail:*)'] },
      user: noRules,
    };
    const r = checkBash({ command: CANONICAL_COMMIT }, docs, root);
    expect(r).toMatchObject({ decision: 'ask', prompt: { reason: 'no-matching-rule' } });
  });

  it('exact rule for the $? echo sub → whole command allows', () => {
    const docs = {
      policy: noRules,
      project: {
        ...noRules,
        allow: ['Bash(git commit:*)', 'Bash(tail:*)', 'Bash(echo "---exit: $?---")'],
      },
      user: noRules,
    };
    const r = checkBash({ command: CANONICAL_COMMIT }, docs, root);
    expect(r).toMatchObject({ decision: 'allow' });
  });

  it('suggests Bash(git commit:*) — the stripped sub yields a reusable prefix rule', () => {
    const r = checkBash({ command: CANONICAL_COMMIT }, EMPTY_DOCS, root);
    expect(r.decision).toBe('ask');
    if (r.decision !== 'ask') return;
    expect(r.prompt.suggestedRules).toContain('Bash(git commit:*)');
    // The prompt surfaces the ORIGINAL command — stripped text never leaks to
    // the renderer card or rule persistence.
    expect((r.prompt.input as { command: string }).command).toBe(CANONICAL_COMMIT);
  });

  /** A malformed variant must never launder into the reusable `git commit` prefix. */
  const commitPrefixAllowed = {
    policy: noRules,
    project: { ...noRules, allow: ['Bash(git commit:*)'] },
    user: noRules,
  };

  it('SECURITY: command-name-position heredoc substitution is not stripped to an empty (allow) command', () => {
    const r = checkBash({ command: `$(cat <<'EOF'\nrm -rf ~\nEOF\n)` }, commitPrefixAllowed, root);
    expect(r).toMatchObject({ decision: 'ask' });
    if (r.decision !== 'ask') return;
    expect(r.prompt.suggestedRules).toEqual([]);
  });

  it('SECURITY: suffix after the substitution survives the strip and is rule-checked', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Bash(git commit:*)'], deny: ['Bash(rm:*)'] },
      user: noRules,
    };
    const cmd = `git commit -m "$(cat <<'EOF'\nmsg\nEOF\n)"; rm -rf /`;
    const r = checkBash({ command: cmd }, docs, root);
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'rule:deny' } });
  });

  it.each([
    ['unquoted delimiter (live body)', 'git commit -m "$(cat <<EOF\nmsg\nEOF\n)"'],
    [
      'mixed safe + unquoted-delimiter substitutions (no partial-strip laundering)',
      `git commit -m "$(cat <<'A'\nx\nA\n)" --trailer "$(cat <<B\ny\nB\n)"`,
    ],
    [
      'unterminated outer $( with well-formed inner substitution',
      `git commit -m "$(cat <<'A'\nbody\n$(cat <<'B'\nx\nB\n)\ntrailing"`,
    ],
    [
      'body containing a literal delimiter line (bash closes at the FIRST EOF)',
      `git commit -m "$(cat <<'EOF'\nfirst\nEOF\nsecond\nEOF\n)"`,
    ],
  ])('SECURITY: %s stays exact-match-only — Bash(git commit:*) cannot allow it', (_name, cmd) => {
    const r = checkBash({ command: cmd }, commitPrefixAllowed, root);
    expect(r).toMatchObject({ decision: 'ask' });
    if (r.decision !== 'ask') return;
    expect(r.prompt.suggestedRules?.some((rule) => rule.includes('git commit:*'))).toBe(false);
  });

  it('over-cap compound with a safe heredoc commit still yields clean suggestions', () => {
    const cmd = [...Array(51).fill('true'), `git commit -m "$(cat <<'EOF'\nm\nEOF\n)"`].join(' ; ');
    const r = checkBash({ command: cmd }, EMPTY_DOCS, root);
    expect(r).toMatchObject({ decision: 'ask', prompt: { reason: 'over-50-subcommands' } });
    if (r.decision !== 'ask') return;
    const rules = r.prompt.suggestedRules ?? [];
    expect(rules).toContain('Bash(git commit:*)');
    for (const rule of rules) expect(rule).toMatch(/^Bash\(.+:\*\)$/);
  });
});

describe('checkBash — BARE_SHELL_PREFIXES suggestion guard', () => {
  it('never suggests Bash(bash:*) for bash -c', () => {
    const r = checkBash({ command: 'bash -c "rm -rf /"' }, EMPTY_DOCS, root);
    expect(r.decision).toBe('ask');
    if (r.decision !== 'ask') return;
    const rules = r.prompt.suggestedRules ?? [];
    expect(rules.some((rule) => rule.startsWith('Bash(bash'))).toBe(false);
  });

  it('never suggests Bash(sudo:*) or Bash(env:*)', () => {
    for (const cmd of ['sudo rm -rf /', 'env FOO=1 node x.js']) {
      const r = checkBash({ command: cmd }, EMPTY_DOCS, root);
      if (r.decision !== 'ask') continue;
      const rules = r.prompt.suggestedRules ?? [];
      expect(rules.some((rule) => /^Bash\((sudo|env)\b/.test(rule))).toBe(false);
    }
  });

  it('leaves suggestions unset for a wrapper command so the card can still persist a rule', () => {
    const r = checkBash({ command: 'sudo npm install' }, EMPTY_DOCS, root);
    expect(r).toMatchObject({ decision: 'ask' });
    if (r.decision !== 'ask') return;
    expect(r.prompt.suggestedRules).toBeUndefined();
  });

  it('never suggests a wrapper builtin that runs its arguments (noglob/command/coproc …)', () => {
    for (const cmd of ['noglob rm -rf ~', 'command rm -rf ~', 'builtin cd /', 'coproc sleep 1']) {
      const r = checkBash({ command: cmd }, EMPTY_DOCS, root);
      expect(r.decision).toBe('ask');
      if (r.decision !== 'ask') continue;
      const head = cmd.split(' ')[0];
      const rules = r.prompt.suggestedRules ?? [];
      expect(rules.some((rule) => rule.startsWith(`Bash(${head}`))).toBe(false);
    }
  });
});

describe('checkBash — empty docs fallback', () => {
  it('no rules + simple command → ask', () => {
    const r = checkBash({ command: 'npm test' }, EMPTY_DOCS, root);
    expect(r).toMatchObject({ decision: 'ask', prompt: { reason: 'no-matching-rule' } });
  });
});

describe('checkBash — commands outside READ/WRITE_COMMANDS carry no tier-1c paths', () => {
  // Containment lives on the commands that TOUCH FILES (ruling:
  // bash-command-permission-safety-tier). `git` is in neither list, so a
  // secret-reaching argument of `git diff --no-index` is an ask, not a deny —
  // the known cost of the two-list scope. Pinned so a future widening of
  // READ_COMMANDS to cover it is a deliberate change, not drift.
  it('git diff --no-index against a secret path asks rather than denies', () => {
    const r = checkBash(
      { command: 'git diff --no-index ~/.ssh/id_rsa /dev/null' },
      EMPTY_DOCS,
      root,
    );
    expect(r).toMatchObject({ decision: 'ask' });
  });
});

describe('checkBash — a command the tokenizer cannot read stays approvable', () => {
  it('a zsh-only expansion is offered its exact rule and that rule re-allows it', () => {
    // shell-quote throws on `${(%)…}`, so the sub carries no tokens at all; the
    // raw text is the only thing a rule can key on.
    const command = 'echo ${(%)foo}';
    const r = checkBash({ command }, EMPTY_DOCS, root);
    expect(r).toMatchObject({ decision: 'ask' });
    if (r.decision !== 'ask') return;
    const offered = r.prompt.suggestedRules ?? [];
    expect(offered).toEqual([`Bash(${command.replace(/[()]/g, '\\$&')})`]);
    expect(validateRuleString(offered[0], 'allow')).toMatchObject({ ok: true });
    const docs = { policy: noRules, project: { ...noRules, allow: offered }, user: noRules };
    expect(checkBash({ command }, docs, root)).toEqual({ decision: 'allow' });
  });
});

describe('checkBash — shell startup files are write-denied, read-open (sc-1668)', () => {
  const home = nodeOs.homedir();
  // Tool-wide Bash allow: tier-1c must win however broad the grant.
  const allowAll = { policy: noRules, project: noRules, user: { ...noRules, allow: ['Bash'] } };
  const check = (command: string, projectRoot = root) =>
    checkBash({ command }, allowAll, projectRoot);

  it.each([
    ['echo x >> ~/.zshrc', '.zshrc'],
    ['echo x > ~/.bashrc', '.bashrc'],
    ['echo x 2>> ~/.zshenv', '.zshenv'],
    ['echo x &> ~/.profile', '.profile'],
    ['echo x >& ~/.zshrc', '.zshrc'],
    ['tee -a ~/.zshrc', '.zshrc'],
    ['cp evil ~/.bashrc', '.bashrc'],
    ['mv /tmp/evil ~/.zprofile', '.zprofile'],
    ['touch ~/.config/fish/conf.d/evil.fish', '.config/fish/conf.d/evil.fish'],
    ['rm ~/.zlogin', '.zlogin'],
  ])('%s → safety:write-path', (command, rel) => {
    expect(check(command)).toEqual({
      decision: 'deny',
      reason: { kind: 'safety:write-path', path: nodePath.join(home, rel) },
    });
  });

  it.each([
    ['exec 3<> ~/.zshrc', '.zshrc'],
    ['cat 3<>~/.bashrc', '.bashrc'],
    ['cp -t ~/.config/fish/conf.d evil.fish', '.config/fish/conf.d'],
    ['cp --target-directory ~/.config/fish/conf.d evil.fish', '.config/fish/conf.d'],
    ['install -t~/.config/fish/conf.d evil.fish', '.config/fish/conf.d'],
  ])('%s — read-write opens and -t destinations are writes', (command, rel) => {
    expect(check(command)).toEqual({
      decision: 'deny',
      reason: { kind: 'safety:write-path', path: nodePath.join(home, rel) },
    });
  });

  it.each([
    'install evil ~/.zshrc -m 600',
    'install -m 600 evil ~/.zshrc',
    'cp evil ~/.bashrc --suffix .orig',
  ])('%s — a flag value is never taken for the destination', (command) => {
    expect(check(command)).toMatchObject({ reason: { kind: 'safety:write-path' } });
  });

  it.each([
    'cp -- -test ~/.zshrc',
    'cp -- -tfoo ~/.zshrc',
    'rsync evil ~/.zshrc --exclude foo',
    'rm -- ~/.bashrc',
  ])('%s — end-of-options and trailing values never hide the destination', (command) => {
    expect(check(command)).toMatchObject({ reason: { kind: 'safety:write-path' } });
  });

  it('deny-leaning by design: a startup file as a later copy SOURCE is refused', () => {
    // Accepted false positive: only the first copy operand is treated as a pure read.
    expect(check('cp notes.txt ~/.zshrc /tmp/')).toMatchObject({
      reason: { kind: 'safety:write-path' },
    });
  });

  it('`cp -t /tmp/bak ~/.zshrc` reads the startup file → not denied', () => {
    expect(check('cp -t /tmp/bak ~/.zshrc').decision).not.toBe('deny');
  });

  it('`>& file` onto a credential is denied (was skipped as an fd-dup)', () => {
    expect(check('echo key >& ~/.ssh/authorized_keys')).toMatchObject({
      decision: 'deny',
      reason: { kind: 'safety:path' },
    });
  });

  it.each(['echo x 1>&2', 'echo x >&-'])('%s — fd-dups are still not paths', (command) => {
    expect(check(command)).toMatchObject({ decision: 'allow' });
  });

  it.each([
    'cat ~/.zshrc',
    'cat < ~/.zshrc',
    'grep PATH ~/.bashrc',
    'cp ~/.zshrc ~/.zshrc.bak',
    'rsync ~/.zshrc /tmp/bak',
  ])('%s — reading a startup file is not denied', (command) => {
    expect(check(command).decision).not.toBe('deny');
  });

  it('a write sub inside a compound is denied', () => {
    expect(check('echo hi && echo evil >> ~/.zshrc')).toMatchObject({
      reason: { kind: 'safety:write-path' },
    });
  });

  it('relative `.zshrc` in a no-project chat (root = home) is denied', () => {
    expect(check('echo x >> .zshrc', home)).toMatchObject({
      reason: { kind: 'safety:write-path' },
    });
  });

  it('a project-tracked .zshrc is not denied', () => {
    expect(check('echo x >> .zshrc').decision).not.toBe('deny');
  });

  it('pinned residual: a nested shell is not path-checked (agent-persistence-write-deny)', () => {
    // Best-effort by design, like the credential list's `bash -c` / `cd` residual:
    // unparsed forms reach rules or the Auto reviewer, never a tier-1c deny.
    expect(check("sh -c 'echo evil >> ~/.zshrc'").decision).not.toBe('deny');
  });
});
