import type { IdeSourceType } from '@/components/ui/ide-source-badge';

/**
 * Shared resource info type for agents, skills, and hooks.
 * Used across settings tabs and sidebar widgets.
 */
export type ResourceInfo = {
  name: string;
  type: 'agent' | 'skill' | 'hook';
  enabled: boolean;
  scope: 'global' | 'project';
  projectPath?: string;
  path: string;
  description?: string;
  /** Which CLI type "owns" this resource (for project-scoped resources) */
  cliType?: 'cursor' | 'claude-code';
  /** Frink-shipped first-party asset — read-only "Built-in" in the UI. */
  builtIn?: boolean;
  /** Every configured tool can read it → "Follows you across tools" (the one promise). */
  followsYou?: boolean;
  /** The configured tool(s) that CAN read this — names the gap ("Only in Cursor") when !followsYou. */
  readableBy?: ('claude-code' | 'cursor')[];
  /** Tool-dir copies of this resource — used to reach each copy in the expanded row, not a chip matrix. */
  sources?: { source: IdeSourceType; path: string }[];
  config: {
    name: string;
    type: string;
    source: string;
    path: string;
    description?: string;
    enabled: boolean;
  };
};
