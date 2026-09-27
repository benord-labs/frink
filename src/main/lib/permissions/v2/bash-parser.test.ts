import { describe, expect, it } from 'vitest';
import { extractSignature, INERT_ENV_ASSIGNMENTS, splitCommand } from './bash-parser';

/** The multi-line commit idiom Claude Code agents emit. */
const CANONICAL_COMMIT = `git commit -m "$(cat <<'EOF'
fix: subject line

body line
EOF
)" 2>&1 | tail -25; echo "---exit: $?---"`;

describe('splitCommand — compound splitting', () => {
  it('splits on &&', () => {
    expect(splitCommand('git add . && git push').map((s) => s.raw)).toEqual([
      'git add .',
      'git push',
    ]);
  });

  it('splits on |', () => {
    expect(splitCommand('find . | xargs rm')).toHaveLength(2);
  });

  it('splits on || and ; (3 sigs)', () => {
    expect(splitCommand('a || b ; c')).toHaveLength(3);
  });

  it('does NOT split inside double quotes', () => {
    const subs = splitCommand('echo "a && b"');
    expect(subs).toHaveLength(1);
    expect(subs[0].raw).toBe('echo "a && b"');
  });

  it('does NOT split inside single quotes', () => {
    const subs = splitCommand("echo 'a && b'");
    expect(subs).toHaveLength(1);
  });

  it('returns empty array for empty input', () => {
    expect(splitCommand('')).toEqual([]);
    expect(splitCommand('   ')).toEqual([]);
  });

  it('skips comment-only chunks', () => {
    expect(splitCommand('# just a comment')).toEqual([]);
  });

  it('returns 55 subcommands for 55-segment compound (no cap here)', () => {
    const cmd = Array(55).fill('true').join(' && ');
    expect(splitCommand(cmd)).toHaveLength(55);
  });
});

describe('splitCommand — expansion detection', () => {
  it('positional $1 sets hasExpansion + raw is verbatim', () => {
    const subs = splitCommand('echo "$1"');
    expect(subs[0].hasExpansion).toBe(true);
    expect(subs[0].raw).toBe('echo "$1"');
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash ${1} expansion under test
  it('${1} positional sets hasExpansion', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash ${1} expansion under test
    expect(splitCommand('echo "${1}"')[0].hasExpansion).toBe(true);
  });

  it('$VAR named expansion sets hasExpansion', () => {
    expect(splitCommand('echo "$HOME"')[0].hasExpansion).toBe(true);
  });

  it('$(...) command sub sets hasExpansion', () => {
    expect(splitCommand('echo $(whoami)')[0].hasExpansion).toBe(true);
  });

  it('backtick sets hasExpansion', () => {
    expect(splitCommand('echo `whoami`')[0].hasExpansion).toBe(true);
  });

  it('heredoc << with NO closer stays hasExpansion (exact-only, conservative)', () => {
    // Unterminated heredoc is not excised — `<<` survives and keeps the safe
    // exact-match-only path. Well-formed heredocs (with a closer) are excised;
    // see the "heredoc excision" block below.
    expect(splitCommand('cat <<EOF')[0].hasExpansion).toBe(true);
  });

  it('process substitution <(...) sets hasExpansion', () => {
    expect(splitCommand('diff <(a) <(b)')[0].hasExpansion).toBe(true);
  });

  it('single-quoted backtick is NOT an expansion (POSIX literal)', () => {
    const subs = splitCommand("echo '`whoami`'");
    expect(subs[0].hasExpansion).toBe(false);
  });

  it('double-quoted backtick IS an expansion', () => {
    const subs = splitCommand('echo "`whoami`"');
    expect(subs[0].hasExpansion).toBe(true);
  });

  it('special parameter $$ (PID) flagged as expansion', () => {
    expect(splitCommand('rm -rf /tmp/$$')[0].hasExpansion).toBe(true);
  });

  it('special parameter $? (last exit) flagged as expansion', () => {
    expect(splitCommand('echo $?')[0].hasExpansion).toBe(true);
  });

  it('special parameter $@ (all args) flagged as expansion', () => {
    expect(splitCommand('echo $@')[0].hasExpansion).toBe(true);
  });

  it('lowercase $var flagged as expansion', () => {
    expect(splitCommand('echo $path_to_evil')[0].hasExpansion).toBe(true);
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash ${myVar} expansion under test
  it('mixed-case ${myVar} flagged as expansion', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash ${myVar} expansion under test
    expect(splitCommand('echo ${myVar}')[0].hasExpansion).toBe(true);
  });
});

describe('splitCommand — heredoc excision', () => {
  it('well-formed heredoc → 1 sub, base extracted, NOT exact-only (no phantoms)', () => {
    // Body deliberately contains `;` and `|` — splitRaw would mis-split it into
    // phantom subcommands if the body were not excised first.
    const cmd = 'cat > /tmp/f.json << \'EOF\'\n{ "a":1; "b":2 | 3 }\nEOF';
    const subs = splitCommand(cmd);
    expect(subs).toHaveLength(1);
    const sig = extractSignature(subs[0]);
    expect(sig.base).toBe('cat');
    expect(sig.isExactMatchOnly).toBe(false);
    expect(subs[0].hasExpansion).toBe(false);
  });

  it('bare cat <<EOF with closer → base extracted', () => {
    const sig = extractSignature(splitCommand('cat <<EOF\nhello\nEOF')[0]);
    expect(sig.base).toBe('cat');
    expect(sig.isExactMatchOnly).toBe(false);
  });

  it('<<- tab-indented closer is matched', () => {
    const sig = extractSignature(splitCommand('cat <<-EOF\n\tbody\n\tEOF')[0]);
    expect(sig.base).toBe('cat');
    expect(sig.isExactMatchOnly).toBe(false);
  });

  it('quoted delimiter <<"EOF" is matched', () => {
    const sig = extractSignature(splitCommand('cat <<"EOF"\nbody\nEOF')[0]);
    expect(sig.base).toBe('cat');
  });

  it('trailing command after a heredoc opener survives and is checked', () => {
    const subs = splitCommand('cat <<EOF && rm -rf z\nbody\nEOF');
    expect(subs.map((s) => extractSignature(s).base)).toEqual(['cat', 'rm']);
  });

  it('command-prefix expansion still flags (the $VAR precedes <<)', () => {
    expect(splitCommand('cat $TARGET <<EOF\nx\nEOF')[0].hasExpansion).toBe(true);
  });

  it('SECURITY: double-quoted 1<<4 bit-shift is NOT excised; trailing rm survives', () => {
    // No `EOF`-style closer + digit before `<<` + non-letter delimiter → the
    // `<<` is never treated as a heredoc, so `rm -rf z` keeps its check.
    const subs = splitCommand('echo a && awk "BEGIN{print 1<<4}" f && rm -rf z');
    expect(subs.map((s) => extractSignature(s).base)).toContain('rm');
  });

  it('indented delimiter-lookalike body line does NOT close early (no phantom subs)', () => {
    // Bash closes `<<EOF` only on a line that is EXACTLY `EOF` — an indented
    // `  EOF` is body, not the closer. A `.trim()` closer check would close
    // here and resurface the `; rm` in the leftover body as a phantom sub.
    const subs = splitCommand('cat <<EOF\n  EOF\nx ; rm -rf z\nEOF');
    expect(subs.map((s) => extractSignature(s).base)).toEqual(['cat']);
  });

  it('CRLF line endings: a closer with trailing \\r still terminates the heredoc', () => {
    const subs = splitCommand('cat <<EOF\r\nbody\r\nEOF\r');
    expect(subs).toHaveLength(1);
    expect(extractSignature(subs[0]).base).toBe('cat');
  });

  it('command BEFORE the heredoc is preserved and checked (mkdir && cat > f << EOF)', () => {
    const subs = splitCommand('mkdir -p d && cat > d/f.json << \'EOF\'\n{"k":1}\nEOF');
    expect(subs.map((s) => extractSignature(s).base)).toEqual(['mkdir', 'cat']);
  });

  it('heredoc piped into another command keeps both subs', () => {
    const subs = splitCommand('cat <<EOF | grep x\nfoo\nEOF');
    expect(subs.map((s) => extractSignature(s).base)).toEqual(['cat', 'grep']);
  });

  it('unterminated heredoc consumes the rest as body — no phantom explosion (O(n) guard)', () => {
    // Many closer-less openers must not trigger an O(n²) closer re-scan, and
    // must not split the opaque body into a sub per line.
    const subs = splitCommand(Array(100).fill('x<<y').join('\n'));
    expect(subs).toHaveLength(1);
    expect(subs[0].hasExpansion).toBe(true);
  });

  it('trailing command on a closer-less heredoc opener line is still checked', () => {
    // `&& rm -rf z` shares the opener line → runs after `cat` → must keep its check.
    const subs = splitCommand('cat <<NOPE && rm -rf z');
    expect(subs.map((s) => extractSignature(s).base)).toContain('rm');
  });
});

describe('splitCommand — safe heredoc substitution carve-out', () => {
  it('canonical commit → 3 subs; commit sub has a real `git commit` signature', () => {
    const subs = splitCommand(CANONICAL_COMMIT);
    expect(subs).toHaveLength(3);
    expect(extractSignature(subs[0])).toMatchObject({
      base: 'git',
      subcommand: 'commit',
      fullSignature: 'git commit',
      isExactMatchOnly: false,
    });
    expect(extractSignature(subs[1]).base).toBe('tail');
    // `$?` keeps the echo sub exact-match-only — asks, never auto-allows.
    expect(extractSignature(subs[2]).isExactMatchOnly).toBe(true);
  });

  it('an unquoted (bare) substitution argument is not stripped and stays exact-match-only', () => {
    const subs = splitCommand(`echo prefix $(cat <<'EOF'\nhello\nEOF\n)`);
    expect(subs.some((sub) => extractSignature(sub).isExactMatchOnly)).toBe(true);
  });

  it('command-name-position substitution keeps the $( and stays exact-match-only', () => {
    const subs = splitCommand(`$(cat <<'EOF'\nrm -rf ~\nEOF\n)`);
    expect(subs.length).toBeGreaterThan(0);
    // The tokenizer surfaces no real command name here, so the exact-only flag is
    // the whole protection — a prefix rule has nothing meaningful to match.
    expect(extractSignature(subs[0])).toMatchObject({ isExactMatchOnly: true });
    expect(extractSignature(subs[0]).base).not.toBe('cat');
  });
});

describe('splitCommand — env stripping', () => {
  it('strips safe env NODE_ENV', () => {
    const sub = splitCommand('NODE_ENV=prod npm test')[0];
    expect(sub.envAssignments).toEqual({ NODE_ENV: 'prod' });
  });

  it('strips multiple safe envs', () => {
    const sub = splitCommand('NODE_ENV=x DEBUG=y npm test')[0];
    expect(sub.envAssignments).toEqual({ NODE_ENV: 'x', DEBUG: 'y' });
  });

  it('does NOT strip unsafe PATH', () => {
    const sub = splitCommand('PATH=/tmp/evil npm test')[0];
    expect(sub.envAssignments).toEqual({});
  });
});

describe('splitCommand — redirection stripping', () => {
  it('strips > /dev/null', () => {
    const sub = splitCommand('npm test > /dev/null')[0];
    expect(sub.redirections.length).toBeGreaterThan(0);
  });

  it('strips 2>&1', () => {
    const sub = splitCommand('npm test 2>&1')[0];
    expect(sub.redirections.some((r) => r.includes('2>&1'))).toBe(true);
  });

  it('signature is clean after redirection stripping', () => {
    const sig = extractSignature(splitCommand('npm test > /dev/null')[0]);
    expect(sig.fullSignature).toBe('npm test');
    expect(sig.isExactMatchOnly).toBe(false);
  });
});

describe('extractSignature', () => {
  it('clean command → base + subcommand', () => {
    const sig = extractSignature(splitCommand('git push origin main')[0]);
    expect(sig).toMatchObject({
      base: 'git',
      subcommand: 'push',
      fullSignature: 'git push',
      isExactMatchOnly: false,
    });
  });

  it('skips flags to find subcommand', () => {
    const sig = extractSignature(splitCommand('git -C /path push origin main')[0]);
    expect(sig.subcommand).toBe('push');
  });

  it('safe-env-prefixed command extracts base from underlying command', () => {
    const sig = extractSignature(splitCommand('NODE_ENV=prod npm test')[0]);
    expect(sig.fullSignature).toBe('npm test');
    expect(sig.isExactMatchOnly).toBe(false);
  });

  it('unsafe-env-prefixed command → isExactMatchOnly', () => {
    const sig = extractSignature(splitCommand('PATH=/tmp/evil npm test')[0]);
    expect(sig.isExactMatchOnly).toBe(true);
    expect(sig.fullSignature).toBe('PATH=/tmp/evil npm test');
  });

  it('mixed safe + unsafe env → isExactMatchOnly (PATH leaks through)', () => {
    const sig = extractSignature(splitCommand('NODE_ENV=x PATH=/tmp npm test')[0]);
    expect(sig.isExactMatchOnly).toBe(true);
  });

  it('$1 expansion → isExactMatchOnly + raw fullSignature, NOT "1"', () => {
    const sig = extractSignature(splitCommand('echo "$1"')[0]);
    expect(sig.isExactMatchOnly).toBe(true);
    expect(sig.fullSignature).toBe('echo "$1"');
    expect(sig.fullSignature).not.toBe('1');
  });

  it('$VAR expansion → isExactMatchOnly', () => {
    const sig = extractSignature(splitCommand('echo "$HOME"')[0]);
    expect(sig.isExactMatchOnly).toBe(true);
  });
});

describe('extractSignature — syntax the parser cannot analyse is exact-match-only, never denied', () => {
  it.each(['echo `whoami`', 'echo $(whoami)', 'echo "`whoami`"'])(
    'substitution %s keeps its base so a prefix DENY can still fire',
    (cmd) => {
      const sub = splitCommand(cmd)[0];
      expect(extractSignature(sub)).toMatchObject({
        base: 'echo',
        fullSignature: cmd,
        isExactMatchOnly: true,
      });
    },
  );

  it.each([
    'eval "rm -rf /"',
    'exec /bin/sh',
    'source .env',
    '. .env',
    'zmodload foo',
    'zcompile foo.zsh',
    'autoload -U colors',
  ])('eval-like head %s keeps its base but is exact-match-only', (cmd) => {
    const sub = splitCommand(cmd)[0];
    expect(extractSignature(sub)).toMatchObject({
      base: cmd.split(' ')[0],
      fullSignature: cmd,
      isExactMatchOnly: true,
    });
  });

  it('an unsafe env prefix keeps the real head as the base, still exact-match-only', () => {
    expect(extractSignature(splitCommand('PATH=/tmp/evil npm test')[0])).toMatchObject({
      base: 'npm',
      subcommand: 'test',
      isExactMatchOnly: true,
    });
  });

  it('backtick inside single quotes is a POSIX literal → real prefix signature', () => {
    expect(extractSignature(splitCommand("echo '`whoami`'")[0])).toMatchObject({
      base: 'echo',
      isExactMatchOnly: false,
    });
  });

  it('a backslash inside single quotes is literal, so the quote closes and a following $( is live', () => {
    // `echo '\'$(rm -rf ~)` prints a backslash, then runs the substitution.
    const sub = splitCommand("echo '\\'$(rm -rf ~)")[0];
    expect(sub.hasExpansion).toBe(true);
    expect(extractSignature(sub).isExactMatchOnly).toBe(true);
  });
});

describe('splitCommand — POSIX single quotes end at the next quote, escaped or not', () => {
  it('SECURITY: a trailing backslash inside single quotes does not swallow the next subcommand', () => {
    // Bash reads `'a\'` as the literal `a\` and closes the quote, so `&& rm -rf /`
    // is a real subcommand. Escaping there hid `rm` from rule eval entirely.
    const subs = splitCommand("echo 'a\\' && rm -rf /");
    expect(subs.map((s) => s.raw)).toEqual(["echo 'a\\'", 'rm -rf /']);
    expect(subs.map((s) => extractSignature(s).base)).toEqual(['echo', 'rm']);
  });

  it('a single-quoted backslash before a heredoc opener still leaves the heredoc detectable', () => {
    // maskQuoted locates `<<` openers on the same quote rules; the body must be
    // excised so the sub keeps a reusable `cat` prefix signature.
    const subs = splitCommand("cat 'x\\' <<EOF\nbody\nEOF");
    expect(subs).toHaveLength(1);
    expect(extractSignature(subs[0])).toMatchObject({ base: 'cat', isExactMatchOnly: false });
  });
});

describe('INERT_ENV_ASSIGNMENTS', () => {
  it('contains the documented safe vars', () => {
    expect(INERT_ENV_ASSIGNMENTS.has('NODE_ENV')).toBe(true);
    expect(INERT_ENV_ASSIGNMENTS.has('CI')).toBe(true);
    expect(INERT_ENV_ASSIGNMENTS.has('DEBUG')).toBe(true);
  });

  it('does NOT contain unsafe vars', () => {
    expect(INERT_ENV_ASSIGNMENTS.has('PATH')).toBe(false);
    expect(INERT_ENV_ASSIGNMENTS.has('LD_PRELOAD')).toBe(false);
    expect(INERT_ENV_ASSIGNMENTS.has('PYTHONPATH')).toBe(false);
    expect(INERT_ENV_ASSIGNMENTS.has('NODE_OPTIONS')).toBe(false);
  });
});
