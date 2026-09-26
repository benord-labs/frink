// Hand-maintained permanent structure-rule exemptions.
//
// Each entry is an INTENTIONAL architectural exception — NOT a legacy
// grandfather awaiting cleanup. Use eslint/baselines/renderer.mjs / eslint/baselines/main.mjs
// for those (shrink-only legacy lists).
//
// To exempt a file:
//   1. Add the relative path (relative to src/renderer/ or src/main/) here.
//   2. Add an inline `// reason` comment explaining the architectural choice.
//   3. Remove the file from the corresponding baseline file.
//
// Removing an entry restores the structure check for that file.

export const rendererStructureExempt = [
  // 'components/Foo.tsx', // example — vendored shadcn primitive, kebab root intentional
];

export const mainStructureExempt = [
  'constants.test.ts', // colocated test for the sanctioned root file constants.ts — intentional flat root, not a legacy violator
];

// Permanent IMPORT-WALL exemptions — independent-modules Module entries,
// spread FIRST in eslint.config.mjs (first match wins). Each carries its own
// reason; these never shrink (unlike the shrink-only eslint/baselines/imports.mjs).
export const importWallExempt = [
  {
    // tRPC client type inference REQUIRES the AppRouter type from main's router
    // implementation — it cannot move to src/shared. The ONE sanctioned
    // cross-boundary import (src/renderer/lib/trpc.ts).
    name: 'renderer-trpc-bridge (permanent exempt)',
    pattern: 'src/renderer/lib/trpc.ts',
    allowImportsFrom: ['{renderer_base}', 'src/main/lib/trpc/routers/**'],
  },
];
