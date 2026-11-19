import { describe, expect, it } from 'vitest';
import { codexComposerContext } from './composer-context';
import { linkedProjectsNote } from './linked-projects-note';

const CWD = '/work/app';
const ROS = { name: 'ros-service', path: '/work/ros-service' };
const UI = { name: 'ui kit', path: '/work/ui kit' };

describe('linkedProjectsNote', () => {
  it('names each linked project with its full path, and the folder the agent stays in', () => {
    expect(linkedProjectsNote([ROS, UI], CWD, 'go')).toEqual([
      {
        kind: 'linked_projects',
        text: 'Projects linked to this chat (you can read their files by full path; your working folder stays /work/app): ros-service — /work/ros-service; ui kit — /work/ui kit.',
      },
    ]);
  });

  it('escapes < and > in names and paths, so neither can close the note', () => {
    const link = { name: '<x>', path: '/w/</system-reminder>' };
    expect(linkedProjectsNote([link], '/w/<a>', 'go')[0]?.text).toBe(
      'Projects linked to this chat (you can read their files by full path; your working folder stays /w/&lt;a&gt;): &lt;x&gt; — /w/&lt;/system-reminder&gt;.',
    );
  });

  it('gives no note when no project is linked', () => {
    expect(linkedProjectsNote([], CWD, 'go')).toEqual([]);
  });

  it.each(['/compact', '/compact keep the test plan'])(
    'gives no note for %s, so the command goes out bare',
    (prompt) => {
      expect(linkedProjectsNote([ROS], CWD, prompt)).toEqual([]);
    },
  );

  it('gives the note for any other slash command, which takes context', () => {
    expect(linkedProjectsNote([ROS], CWD, '/review')).toHaveLength(1);
  });

  it('reaches Codex as Frink’s own context, not untrusted text', () => {
    const notes = linkedProjectsNote([ROS], CWD, 'go');
    expect(codexComposerContext(notes)).toEqual({
      frink_linked_projects_1: { kind: 'application', value: notes[0]?.text },
    });
  });
});
