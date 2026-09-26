/**
 * A file path rendered as a truncating directory prefix followed by an always-visible
 * filename. The filename is what identifies the row, so it never truncates — the
 * directory gives way instead when the row is too narrow.
 */
export function FilePathLabel({ dirPath, fileName }: { dirPath: string; fileName: string }) {
  return (
    <div className="flex-1 min-w-0 flex items-center overflow-hidden">
      {dirPath && (
        <span className="text-xs text-muted-foreground truncate shrink min-w-0">{dirPath}/</span>
      )}
      <span className="text-xs font-medium shrink-0 whitespace-nowrap">{fileName}</span>
    </div>
  );
}
