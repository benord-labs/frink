type BranchDataShape = {
  current?: string;
  local?: unknown;
  remote?: unknown;
  defaultBranch?: string;
  checkedOutBranches?: unknown;
};

export type BranchListItem = {
  name: string;
  type: 'local' | 'remote';
  protected: boolean;
  isDefault: boolean;
  committedAt: string | null;
  authorName: null;
  checkedOutIn: string | null;
};

export function normalizeLocalBranches(
  value: unknown,
): Array<{ branch: string; lastCommitDate: number }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const branch = (item as { branch?: unknown }).branch;
      const lastCommitDate = (item as { lastCommitDate?: unknown }).lastCommitDate;
      if (typeof branch !== 'string') return null;
      return {
        branch,
        lastCommitDate: typeof lastCommitDate === 'number' ? lastCommitDate : 0,
      };
    })
    .filter((item): item is { branch: string; lastCommitDate: number } => item !== null);
}

export function normalizeRemoteBranches(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function normalizeCheckedOutBranches(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [branch, path] of Object.entries(value)) {
    if (typeof path === 'string') {
      result[branch] = path;
    }
  }
  return result;
}

export function transformBranchData(data: unknown): BranchListItem[] {
  const source = (data ?? {}) as BranchDataShape;
  const local = normalizeLocalBranches(source.local);
  const remote = normalizeRemoteBranches(source.remote);
  const defaultBranch = typeof source.defaultBranch === 'string' ? source.defaultBranch : '';
  const checkedOutBranches = normalizeCheckedOutBranches(source.checkedOutBranches);
  const result: BranchListItem[] = [];

  for (const { branch, lastCommitDate } of local) {
    result.push({
      name: branch,
      type: 'local',
      protected: false,
      isDefault: branch === defaultBranch,
      committedAt: lastCommitDate ? new Date(lastCommitDate).toISOString() : null,
      authorName: null,
      checkedOutIn: checkedOutBranches[branch] ?? null,
    });
  }

  for (const name of remote) {
    result.push({
      name,
      type: 'remote',
      protected: false,
      isDefault: name === defaultBranch,
      committedAt: null,
      authorName: null,
      checkedOutIn: null,
    });
  }

  return result.sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;
    if (a.type !== b.type) return a.type === 'local' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
