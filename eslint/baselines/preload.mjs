// Grandfather list of files violating the src/preload
// folder-structure rule at the time it was introduced.
//
// New files MUST follow the structure (see eslint.config.mjs). Existing
// violators stay in this list until they're touched. When you fix a file
// to match the new structure, REMOVE its entry here. Do NOT add new
// entries — the goal is to shrink this list to zero.
//
// For INTENTIONAL permanent exemptions (architectural choice, not legacy):
// use eslint/baselines/exempt.mjs instead. That file is hand-maintained and
// requires a reason per entry.
//
// Hand-maintained and shrink-only: nothing regenerates this list.

export const preloadStructureBaseline = [];
