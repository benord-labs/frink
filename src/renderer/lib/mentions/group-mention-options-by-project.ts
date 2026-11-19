/**
 * The @ picker's rows, grouped by project when the chat links others: the chat's own project
 * first, then each linked project in link order, each under its name.
 */
import { matchesMultiWordSearch, sortFilesByRelevance } from './agents-file-mention-search-helpers';
import type { FileMentionOption } from './agents-mentions-types';

/** One project's options, in the order they show. `path` is the folder they were found in. */
type MentionProjectGroup = { path: string; name: string; options: FileMentionOption[] };

/** A file or folder files.search found in a project, by its path inside the project */
type SearchEntry = { label: string; path: string; type: 'file' | 'folder' };

/** An option with its place in keyboard order */
type MentionSectionRow = { key: string; option: FileMentionOption; index: number };

/** A run of rows under one title */
type MentionSection = {
  key: string;
  /** The project's name, or null for rows under the picker's usual header */
  name: string | null;
  /** A project linked to the chat, not the chat's own */
  linked: boolean;
  rows: MentionSectionRow[];
};

/**
 * A file or folder files.search found in a linked project, as an option. Its id holds the full
 * path, so the agent finds it there and never looks for it in the chat's own folder.
 */
export function linkedMentionOption(
  root: { path: string; name: string },
  entry: SearchEntry,
): FileMentionOption {
  const path = `${root.path}/${entry.path}`;
  return {
    id: `${entry.type}:local:${path}`,
    label: entry.label,
    path,
    repository: 'local',
    truncatedPath: entry.path.split('/').slice(0, -1).join('/') || '/',
    treePath: `${root.name}/${entry.path}`,
    type: entry.type,
  };
}

/** Each linked project's results that hold every word of `searchText`, best match first */
export function linkedMentionGroups(
  roots: ReadonlyArray<{ path: string; name: string }>,
  results: ReadonlyArray<ReadonlyArray<SearchEntry> | undefined>,
  searchText: string,
): MentionProjectGroup[] {
  const searchLower = searchText.toLowerCase();
  return roots.map((root, i) => ({
    path: root.path,
    name: root.name,
    options: sortFilesByRelevance(
      (results[i] ?? [])
        // Matched inside the project, so the name of a folder above it matches nothing
        .filter((entry) => matchesMultiWordSearch(entry.path, searchLower))
        .map((entry) => linkedMentionOption(root, entry)),
      searchText,
    ),
  }));
}

/** Files and folders sit under their project; categories, skills, agents and tools do not. */
const isProjectEntry = (option: FileMentionOption) =>
  option.type === undefined || option.type === 'file' || option.type === 'folder';

/**
 * The sections to show and, in the same order, the options the arrow keys move through, each
 * with a key. With no linked project the list is `main`'s options alone, under the picker's
 * usual header. Otherwise `main`'s options that are not files keep that header, and each
 * project with files gets a section under its name. A key pairs the project's folder with the
 * option's id, so a file in two linked projects, one inside the other, shows under each.
 */
export function groupMentionOptionsByProject(
  main: MentionProjectGroup,
  linked: MentionProjectGroup[],
): { sections: MentionSection[]; options: FileMentionOption[]; keys: string[] } {
  const runs: Array<[group: MentionProjectGroup, name: string | null, of: FileMentionOption[]]> =
    linked.length === 0
      ? [[main, null, main.options]]
      : [
          [main, null, main.options.filter((option) => !isProjectEntry(option))],
          [main, main.name, main.options.filter(isProjectEntry)],
          ...linked.map((group): [MentionProjectGroup, string, FileMentionOption[]] => [
            group,
            group.name,
            group.options,
          ]),
        ];
  const options: FileMentionOption[] = [];
  const keys: string[] = [];
  const sections: MentionSection[] = [];
  for (const [group, name, of] of runs) {
    if (of.length === 0) continue;
    const rows = of.map((option) => {
      const row = { key: `${group.path}:${option.id}`, option, index: options.length };
      options.push(option);
      keys.push(row.key);
      return row;
    });
    const key = name === null ? 'results' : `project:${group.path}`;
    sections.push({ key, name, linked: group !== main, rows });
  }
  return { sections, options, keys };
}

/**
 * Where the selection goes when the list changes under it: to the row it was on, wherever that
 * row now is, else the same place, kept inside the list. An empty list keeps it as it was.
 */
export function followSelection(
  previousKeys: readonly string[],
  keys: readonly string[],
  selectedIndex: number,
): number {
  if (keys.length === 0) return selectedIndex;
  const selectedKey = previousKeys[selectedIndex];
  const kept = selectedKey === undefined ? -1 : keys.indexOf(selectedKey);
  return kept === -1 ? Math.min(selectedIndex, keys.length - 1) : kept;
}
