import type { MobileChatChanges, MobileDiffLine } from '@frink/shared/types/remote/mobile';

/** The fixture chat's worktree: 38 lines added and 12 removed across three files. */
export function chatChangesFixture(): MobileChatChanges {
  const added = Array.from({ length: 34 }, (_, index): MobileDiffLine => ({
    kind: 'add',
    text: `  expect(await frame.step(${index})).toBe(true);`,
    newNo: index + 1,
  }));
  return {
    additions: 38,
    deletions: 12,
    fileCount: 3,
    truncated: false,
    files: [
      {
        path: 'tests/checkout.spec.ts',
        status: 'modified',
        additions: 2,
        deletions: 1,
        hunks: [
          {
            header: '@@ -40,3 +40,4 @@ test("pays", async () => {',
            lines: [
              {
                kind: 'ctx',
                text: '  const frame = await openPayment(page);',
                oldNo: 40,
                newNo: 40,
              },
              { kind: 'del', text: '  await page.waitForTimeout(500);', oldNo: 41 },
              { kind: 'add', text: '  await waitForFrame(frame, "ready");', newNo: 41 },
              { kind: 'add', text: '  await frame.getByRole("button").click();', newNo: 42 },
              {
                kind: 'ctx',
                text: '  await expect(page).toHaveURL(/done/);',
                oldNo: 42,
                newNo: 43,
              },
            ],
          },
        ],
      },
      {
        path: 'tests/helpers/frames.ts',
        status: 'added',
        additions: 34,
        deletions: 0,
        hunks: [{ header: '@@ -0,0 +1,34 @@', lines: added }],
      },
      {
        path: '.env',
        status: 'modified',
        additions: 2,
        deletions: 11,
        hunks: [],
        omitted: 'secret',
      },
    ],
  };
}
