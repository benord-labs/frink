import type { OpenFile } from '@/lib/code-editor/state';
import { getProjectName } from './project-name';

export type FileProjectGroup = {
  projectPath: string | undefined;
  projectName: string;
  files: OpenFile[];
};

/**
 * Group open files by their `projectPath` for the tab-bar separators, preserving
 * first-seen project order. Files with no `projectPath` collect under a single
 * "Files" group (keyed internally by the `__none__` sentinel).
 */
export function groupFilesByProject(files: OpenFile[]): FileProjectGroup[] {
  const grouped: FileProjectGroup[] = [];
  const projectOrder: string[] = [];
  const byProject = new Map<string, OpenFile[]>();

  for (const f of files) {
    const key = f.projectPath ?? '__none__';
    if (!byProject.has(key)) {
      byProject.set(key, []);
      projectOrder.push(key);
    }
    const group = byProject.get(key);
    if (group) group.push(f);
  }

  for (const key of projectOrder) {
    const projectFiles = byProject.get(key);
    if (!projectFiles) continue;
    grouped.push({
      projectPath: key === '__none__' ? undefined : key,
      projectName: key === '__none__' ? 'Files' : (getProjectName(key) ?? key),
      files: projectFiles,
    });
  }

  return grouped;
}
