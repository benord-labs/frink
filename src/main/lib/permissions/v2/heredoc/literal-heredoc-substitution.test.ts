import { describe, expect, it } from 'vitest';
import { inlineLiteralHeredocSubstitutions } from './literal-heredoc-substitution';

/** The multi-line commit idiom Claude Code agents emit. */
const CANONICAL_COMMIT = `git commit -m "$(cat <<'EOF'
fix: subject line

body line
EOF
)" 2>&1 | tail -25; echo "---exit: $?---"`;

describe('inlineLiteralHeredocSubstitutions', () => {
  it.each([
    [
      'canonical commit; pipe/semicolon tail survives',
      CANONICAL_COMMIT,
      `git commit -m 'fix: subject line\n\nbody line' 2>&1 | tail -25; echo "---exit: $?---"`,
    ],
    [
      'inline DELIM) closing form',
      `git commit -m "$(cat <<'EOF'\nmsg\nEOF)"`,
      "git commit -m 'msg'",
    ],
    [
      'inline EOF) closer on the FIRST body line (empty body)',
      `git commit -m "$(cat <<'EOF'\nEOF)"`,
      "git commit -m ''",
    ],
    [
      '<<- closer with leading tabs',
      `git commit -m "$(cat <<-'EOF'\n\tmsg\n\tEOF\n)"`,
      "git commit -m 'msg'",
    ],
    [
      'backslash-escaped delimiter <<\\EOF (quoted-equivalent in bash)',
      'git commit -m "$(cat <<\\EOF\nmsg\nEOF\n)"',
      "git commit -m 'msg'",
    ],
    [
      'body with apostrophes and double quotes (common commit prose)',
      `git commit -m "$(cat <<'EOF'\nfix: don't break "quoted" text\n\nit's fine\nEOF\n)"`,
      `git commit -m 'fix: don'\\''t break "quoted" text\n\nit'\\''s fine'`,
    ],
    [
      'two sibling substitutions both strip',
      `gh pr create --title "$(cat <<'A'\nt\nA\n)" --body "$(cat <<'B'\nb\nB\n)"`,
      "gh pr create --title 't' --body 'b'",
    ],
  ])('inlines: %s', (_name, cmd, expected) => {
    expect(inlineLiteralHeredocSubstitutions(cmd)).toBe(expected);
  });

  // Rejections fall back to the unstripped command (the conservative direction); SECURITY rows would
  // otherwise launder live shell code into an allow.
  it.each([
    [
      'unquoted delimiter (body would expand, not literal)',
      'git commit -m "$(cat <<EOF\nmsg\nEOF\n)"',
    ],
    ['unterminated heredoc (no closer)', `git commit -m "$(cat <<'EOF'\nmsg msg\n)"`],
    ['trailing content on the opener line', `git commit -m "$(cat <<'EOF'; rm -rf /\nmsg\nEOF\n)"`],
    [
      'SECURITY: command-name position — heredoc body would BE the command',
      `$(cat <<'EOF'\nrm -rf ~\nEOF\n)`,
    ],
    [
      'SECURITY: command-name position with trailing args',
      `  $(cat <<'EOF'\nchmod\nEOF\n) 777 /etc/shadow`,
    ],
    [
      'SECURITY: nested matches (stale-index strip corruption guard)',
      `echo "$(cat <<'A'\n$(cat <<'B'\nx\nB\n)\nA\n)"`,
    ],
    ['escaped \\$( opener is not a substitution', `echo "\\$(cat <<'EOF'\nx\nEOF\n)"`],
    ['plain command', 'npm test'],
    ['plain heredoc (no substitution)', `cat > f << 'EOF'\nbody\nEOF`],
    [
      'SECURITY: body containing a literal delimiter line — bash runs the rest as code',
      `git commit -m "$(cat <<'EOF'\nfirst\nEOF\nsecond\nEOF\n)"`,
    ],
    [
      'body line that merely STARTS with the delimiter (conservative)',
      `git commit -m "$(cat <<'EOF'\nEOFY report\nEOF\n)"`,
    ],
    [
      'CRLF closer — bash itself does not close on EOF\\r; Windows-authored stays gated',
      `git commit -m "$(cat <<'EOF'\r\nmsg\r\nEOF\r\n)"`,
    ],
    ['opener with no newline after it', `git commit -m "$(cat <<'EOF'`],
    [
      'pathological candidate flood (33 > cap) — bounded work, deny path',
      Array(33).fill(`x "$(cat <<'EOF'`).join('\n'),
    ],
  ])('null: %s', (_name, cmd) => {
    expect(inlineLiteralHeredocSubstitutions(cmd)).toBeNull();
  });

  it.each([
    // Bash closes at the first `EOF`, so `; rm -rf /` is live code, not body.
    [
      'first closer wins; live text follows it',
      `echo "$(cat <<'EOF'\nbody\nEOF\n); rm -rf /\nEOF)"`,
    ],
    // The unquoted-delimiter substitution is live, so nothing may be partially stripped.
    [
      'one live substitution beside a literal one',
      `git commit -m "$(cat <<'A'\nx\nA\n)" --trailer "$(cat <<B\ny\nB\n)"`,
    ],
  ])('SECURITY null: %s', (_name, cmd) => {
    expect(inlineLiteralHeredocSubstitutions(cmd)).toBeNull();
  });

  // Review findings: each shape runs the body as a command or hides live code,
  // so only a quoted argument after a plain command word may be stripped.
  const BODY = `$(cat <<'EOF'\nrm -rf ~\nEOF\n)`;
  it.each([
    ['opener inside single quotes', `echo '"${BODY}"' ; printf PWNED ; echo '"'`],
    ['quoted env value before it', `FOO='x y' "${BODY}"`],
    ['case arm', `case x in x) "${BODY}" ;; esac`],
    ['leading redirection', `>/tmp/out "${BODY}"`],
    ['time reserved word', `time "${BODY}"`],
    ['glued to the command word', `git"${BODY}"`],
    ['brace group', `{ "${BODY}"; }`],
    ['unquoted argument', `git commit -m ${BODY}`],
    ['text after the closing ) inside the quotes', `git commit -m "${BODY}x"`],
  ])('SECURITY null: %s', (_name, cmd) => {
    expect(inlineLiteralHeredocSubstitutions(cmd)).toBeNull();
  });

  it('repeated calls are deterministic (global-regex lastIndex must never leak state)', () => {
    const first = inlineLiteralHeredocSubstitutions(CANONICAL_COMMIT);
    inlineLiteralHeredocSubstitutions('npm test'); // interleaved no-match call
    expect(inlineLiteralHeredocSubstitutions(CANONICAL_COMMIT)).toBe(first);
    expect(first).not.toBeNull();
  });

  // A substitution in command-name position runs its body as the command. The
  // guard must hold for EVERY substitution, not just one at the very start.
  const LIVE = `$(cat <<'EOF'\nrm -rf ~\nEOF\n)`;
  it.each([
    ['after ;', `echo hi; ${LIVE}`],
    ['after &&', `echo hi && ${LIVE}`],
    ['after ||', `echo hi || ${LIVE}`],
    ['after |', `echo hi | ${LIVE}`],
    ['after background &', `echo hi & ${LIVE}`],
    ['after a newline', `echo hi\n${LIVE}`],
    ['after a subshell (', `echo hi; (${LIVE})`],
    ['double-quoted, after ;', `echo hi; "${LIVE}"`],
    ['behind a leading env assignment', `FOO=1 ${LIVE}`],
    ['after a reserved word (then)', `if true; then ${LIVE}; fi`],
    [
      'second substitution in command position, first one safe',
      `git commit -m "$(cat <<'A'\nm\nA\n)"; ${LIVE}`,
    ],
  ])('SECURITY null: command-name position %s', (_name, cmd) => {
    expect(inlineLiteralHeredocSubstitutions(cmd)).toBeNull();
  });

  // Accepted opener/closer spellings.
  it.each([
    ['space between << and the delimiter', `git commit -m "$(cat << 'EOF'\nm\nEOF\n)"`],
    ['no space between cat and <<', `git commit -m "$(cat<<'EOF'\nm\nEOF\n)"`],
    ['trailing blanks on the opener line', `git commit -m "$(cat <<'EOF'  \nm\nEOF\n)"`],
    ['inline closer with a space before )', `git commit -m "$(cat <<'EOF'\nm\nEOF )"`],
    ['doubled quotes some toolchains emit', `git commit -m "$(cat <<''EOF''\nm\nEOF\n)"`],
    ['indented ) on the line after the closer', `git commit -m "$(cat <<'EOF'\nm\nEOF\n  )"`],
  ])('inlines: %s', (_name, cmd) => {
    expect(inlineLiteralHeredocSubstitutions(cmd)).toBe("git commit -m 'm'");
  });

  // Conservative rejections — each stays exact-match-only rather than guessing.
  it.each([
    ['double-quoted delimiter', `git commit -m "$(cat <<"EOF"\nm\nEOF\n)"`],
    ['space inside $( before cat', `git commit -m "$( cat <<'EOF'\nm\nEOF\n)"`],
    [
      'trailing blanks after the closer (bash does not close on "EOF  ")',
      `git commit -m "$(cat <<'EOF'\nm\nEOF  \n)"`,
    ],
    ['unbalanced quote on the delimiter', `git commit -m "$(cat <<'EOF\nm\nEOF\n)"`],
    ['<<- closer indented with spaces, not tabs', `git commit -m "$(cat <<-'EOF'\nm\n  EOF\n)"`],
  ])('null: %s', (_name, cmd) => {
    expect(inlineLiteralHeredocSubstitutions(cmd)).toBeNull();
  });

  it('exactly 32 candidates (the cap) still inline every one', () => {
    const cmd = Array.from({ length: 32 }, (_, i) => `x "$(cat <<'E${i}'\nb\nE${i}\n)"`).join(' ');
    expect(inlineLiteralHeredocSubstitutions(cmd)).toBe(Array(32).fill("x 'b'").join(' '));
  });
});
