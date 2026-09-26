type DiffFilePathLike = {
  newPath: string;
  oldPath: string;
  key: string;
};

export function getDisplayPath(file: DiffFilePathLike): string {
  if (file.newPath && file.newPath !== '/dev/null') return file.newPath;
  if (file.oldPath && file.oldPath !== '/dev/null') return file.oldPath;
  return file.key;
}

/** Each CodeView file renders in its own shadow root, named by its header title. */
export function getCodeViewFilePath(root: ShadowRoot): string | null {
  return root.querySelector('[data-diffs-header] [data-title]')?.textContent || null;
}

/** The file under a pointer event inside a CodeView, read off the event's composed path. */
export function getCodeViewFilePathFromEvent(event: Event): string | null {
  for (const node of event.composedPath()) {
    if (node instanceof ShadowRoot) return getCodeViewFilePath(node);
  }
  return null;
}
