type DuplicateFileMutationInput = {
  projectPath: string;
  relativePath: string;
  destinationFolder?: string;
};

type DuplicateFileMutation = (input: DuplicateFileMutationInput) => void;

export function duplicateFileToDestination(params: {
  mutate: DuplicateFileMutation;
  projectPath: string;
  relativePath: string;
  destinationFolder?: string;
}): void {
  const { mutate, projectPath, relativePath, destinationFolder } = params;
  mutate({ projectPath, relativePath, destinationFolder });
}

export function pasteCopiedPath(params: {
  copiedPath: string | null;
  targetFolder: string;
  onDuplicate: (relativePath: string, destinationFolder?: string) => void;
  clearCopiedPath: () => void;
}): void {
  const { copiedPath, targetFolder, onDuplicate, clearCopiedPath } = params;
  if (!copiedPath) return;
  onDuplicate(copiedPath, targetFolder);
  clearCopiedPath();
}
