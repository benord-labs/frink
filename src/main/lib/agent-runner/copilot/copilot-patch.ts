/** Copilot's tool that adds, changes, moves and deletes files by patch. */
export const PATCH_TOOL = 'apply_patch';

const ACTIONS = ['Add File', 'Update File', 'Delete File', 'Move to'] as const;

/** One file a patch names: its header, and the patch lines that follow the header. */
export type PatchFile = {
  action: (typeof ACTIONS)[number];
  file: string;
  lines: string[];
};

const PATCH_HEADER =
  /^\*\*\* (?:Begin Patch|End Patch|End of File|(Add File|Update File|Delete File|Move to): (?!~)(\S.*))$/;

/** Every file a patch names, in order, or nothing when any header is one Frink cannot read. */
export function readPatch(patch: string): PatchFile[] | undefined {
  // Split where the patch tool breaks lines, a lone \r included; headers are read trimmed, as it does.
  const lines = patch.split(/\r\n?|\n/);
  if (lines[0]?.trim() !== '*** Begin Patch') return undefined;
  const files: PatchFile[] = [];
  for (const line of lines) {
    if (!line.trim().startsWith('***')) {
      files.at(-1)?.lines.push(line);
      continue;
    }
    const header = PATCH_HEADER.exec(line.trim());
    if (!header) return undefined;
    const [, name, file] = header;
    const action = ACTIONS.find((known) => known === name);
    if (action && file) files.push({ action, file, lines: [] });
  }
  return files.length > 0 ? files : undefined;
}
