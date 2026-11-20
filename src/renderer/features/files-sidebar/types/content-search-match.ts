export type ContentSearchMatch = {
  id: string;
  filePath: string;
  lineNumber: number;
  startColumn: number;
  endColumn: number;
  lineText: string;
  /** The match's span within `lineText`. */
  previewStart: number;
  previewEnd: number;
};
