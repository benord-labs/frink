type SymlinkEscapeResult = { escapes: false } | { escapes: true; realPath: string };

/** How often the open file is re-checked. A link can be swapped in by anything (an agent, a
 * terminal, another editor) and no event covers every source, so the active tab polls. */
export const SYMLINK_ESCAPE_RECHECK_MS = 5_000;

type SymlinkEscapeQueryOptions = {
  enabled: boolean;
  retry: false;
  refetchInterval: number | false;
  refetchOnWindowFocus: 'always';
};

/** The files.symlinkEscape query hook, passed in so tests need no module mock. */
export type UseSymlinkEscapeQuery = (
  input: { projectPath: string; filePath: string },
  options: SymlinkEscapeQueryOptions,
) => { data: SymlinkEscapeResult | undefined };

/** Real location of an open file that a link takes outside its project, else null. */
export function useSymlinkEscape(
  useEscapeQuery: UseSymlinkEscapeQuery,
  projectPath: string | undefined,
  filePath: string | null,
): string | null {
  const enabled = Boolean(projectPath && filePath);
  const { data } = useEscapeQuery(
    { projectPath: projectPath ?? '', filePath: filePath ?? '' },
    {
      enabled,
      retry: false,
      refetchInterval: enabled ? SYMLINK_ESCAPE_RECHECK_MS : false,
      refetchOnWindowFocus: 'always',
    },
  );

  return enabled && data?.escapes ? data.realPath : null;
}
