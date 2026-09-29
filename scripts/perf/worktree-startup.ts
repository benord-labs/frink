/** Read-only benchmark: real ownership probes, no prune, hook repair or worktree deletion. */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { isFrinkManagedWorktree } from '../../src/main/lib/git/worktree/ownership';
import { findUnmanagedWorktrees } from '../../src/main/lib/trpc/routers/chats/git';

const repo = process.argv[2] ?? process.cwd();
const output = process.argv[3] ?? '/tmp/frink-worktree-startup.json';
const paths = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter((line) => line.startsWith('worktree '))
  .map((line) => line.slice(9));
await isFrinkManagedWorktree(repo); // resolve/cache shell environment equally for both modes
const rows: { sample: number; mode: string; durationMs: number; unmanaged: number }[] = [];
let expected: string | undefined;
for (let sample = 0; sample < 3; sample++) {
  for (const mode of sample % 2 ? ['bounded', 'serial'] : ['serial', 'bounded']) {
    const start = performance.now();
    const unmanaged =
      mode === 'bounded'
        ? await findUnmanagedWorktrees(paths, isFrinkManagedWorktree)
        : new Set<string>();
    if (mode === 'serial') {
      for (const path of paths) if (!(await isFrinkManagedWorktree(path))) unmanaged.add(path);
    } else {
      // Production rechecks positive ownership immediately before considering cleanup.
      for (const path of paths) {
        if (!unmanaged.has(path) && !(await isFrinkManagedWorktree(path))) unmanaged.add(path);
      }
    }
    const result = JSON.stringify([...unmanaged].sort());
    expected ??= result;
    if (result !== expected)
      throw new Error('Ownership changed during benchmark; discard timing comparison');
    rows.push({
      sample: sample + 1,
      mode,
      durationMs: performance.now() - start,
      unmanaged: unmanaged.size,
    });
    console.log(JSON.stringify(rows.at(-1)));
    writeFileSync(
      output,
      JSON.stringify(
        {
          scope: 'ownership reads only; same shell cache and registry; no mutations',
          paths: paths.length,
          rows,
        },
        null,
        2,
      ),
    );
  }
}
