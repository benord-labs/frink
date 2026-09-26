import { describe, expect, it } from 'vitest';
import { extractWorkingFileLineChangesFromDiff } from './status';

describe('extractWorkingFileLineChangesFromDiff', () => {
  it('returns added range for pure addition hunks', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -0,0 +1,3 @@
+one
+two
+three`;

    expect(extractWorkingFileLineChangesFromDiff(diff)).toEqual([
      { type: 'added', startLine: 1, endLine: 3 },
    ]);
  });

  it('returns deleted marker anchored to current-file line', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -5,2 +5,0 @@
-old one
-old two`;

    expect(extractWorkingFileLineChangesFromDiff(diff)).toEqual([
      { type: 'deleted', startLine: 5, endLine: 5 },
    ]);
  });

  it('returns modified range for replacement hunks', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,2 +10,4 @@
-old one
-old two
+new one
+new two
+new three
+new four`;

    expect(extractWorkingFileLineChangesFromDiff(diff)).toEqual([
      { type: 'modified', startLine: 10, endLine: 11 },
      { type: 'added', startLine: 12, endLine: 13 },
    ]);
  });

  it('handles hunks without explicit counts', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -3 +3 @@
-before
+after`;

    expect(extractWorkingFileLineChangesFromDiff(diff)).toEqual([
      { type: 'modified', startLine: 3, endLine: 3 },
    ]);
  });

  it('returns empty for empty diff text', () => {
    expect(extractWorkingFileLineChangesFromDiff('')).toEqual([]);
    expect(extractWorkingFileLineChangesFromDiff('   \n')).toEqual([]);
  });

  it('parses multiple mixed hunks in a single diff', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -2,0 +3,2 @@
+add 1
+add 2
@@ -10,2 +12,0 @@
-rm 1
-rm 2
@@ -20,1 +22,1 @@
-before
+after`;

    expect(extractWorkingFileLineChangesFromDiff(diff)).toEqual([
      { type: 'added', startLine: 3, endLine: 4 },
      { type: 'deleted', startLine: 12, endLine: 12 },
      { type: 'modified', startLine: 22, endLine: 22 },
    ]);
  });

  it('parses CRLF-formatted diffs', () => {
    const diff =
      'diff --git a/src/a.ts b/src/a.ts\r\n--- a/src/a.ts\r\n+++ b/src/a.ts\r\n@@ -5,0 +6,1 @@\r\n+x\r\n';

    expect(extractWorkingFileLineChangesFromDiff(diff)).toEqual([
      { type: 'added', startLine: 6, endLine: 6 },
    ]);
  });

  it('classifies mixed add/remove runs as modified with correct span', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,2 +10,3 @@
-old 1
-old 2
+new 1
+new 2
+new 3`;

    expect(extractWorkingFileLineChangesFromDiff(diff)).toEqual([
      { type: 'modified', startLine: 10, endLine: 11 },
      { type: 'added', startLine: 12, endLine: 12 },
    ]);
  });

  it('classifies mixed runs with extra removals as modified plus deleted anchor', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -20,3 +20,1 @@
-old 1
-old 2
-old 3
+new 1`;

    expect(extractWorkingFileLineChangesFromDiff(diff)).toEqual([
      { type: 'modified', startLine: 20, endLine: 20 },
      { type: 'deleted', startLine: 21, endLine: 21 },
    ]);
  });

  it('returns empty for rename-only blocks with no hunks', () => {
    const diff = `diff --git a/src/old.ts b/src/new.ts
similarity index 100%
rename from src/old.ts
rename to src/new.ts`;

    expect(extractWorkingFileLineChangesFromDiff(diff)).toEqual([]);
  });

  it('collapses pure multi-line deletions into a single deletion anchor marker', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -30,4 +30,0 @@
-a
-b
-c
-d`;

    expect(extractWorkingFileLineChangesFromDiff(diff)).toEqual([
      { type: 'deleted', startLine: 30, endLine: 30 },
    ]);
  });
});
