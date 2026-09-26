/* eslint-disable project-structure/folder-structure */
import { describe, expect, it } from 'vitest';
import { projectTriggerLabel, shouldScaffoldNewProject } from '@/lib/agent-chat/new-chat-target';

describe('projectTriggerLabel', () => {
  it("uses the selected project's name when present (any context/target)", () => {
    expect(projectTriggerLabel('my-app', true, 'new')).toBe('my-app');
    expect(projectTriggerLabel('my-app', false, 'unset')).toBe('my-app');
  });

  it('new-chat: unset → "Open project" (the default CTA)', () => {
    expect(projectTriggerLabel('', true, 'unset')).toBe('Open project');
  });

  it('new-chat: general/new reflect the explicit choice', () => {
    expect(projectTriggerLabel('', true, 'general')).toBe('General chat');
    expect(projectTriggerLabel('', true, 'new')).toBe('New project');
  });

  it('non-new-chat callers (flow editor) get the neutral label', () => {
    expect(projectTriggerLabel('', false, 'unset')).toBe('Select project');
  });
});

describe('shouldScaffoldNewProject', () => {
  it('scaffolds ONLY when no project + target is "new"', () => {
    expect(shouldScaffoldNewProject(false, 'new')).toBe(true);
  });

  it('never scaffolds for general or unset (general chat must not spawn a project)', () => {
    expect(shouldScaffoldNewProject(false, 'general')).toBe(false);
    expect(shouldScaffoldNewProject(false, 'unset')).toBe(false);
  });

  it('never scaffolds when an existing project is selected', () => {
    expect(shouldScaffoldNewProject(true, 'new')).toBe(false);
    expect(shouldScaffoldNewProject(true, 'general')).toBe(false);
  });
});
