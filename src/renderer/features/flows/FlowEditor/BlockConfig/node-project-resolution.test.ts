import { describe, expect, it } from 'vitest';
import {
  classifyProjectRef,
  getEffectiveNodeProjectId,
  getNodeProjectFieldError,
  ID_ONLY_PROJECT_RULES as ID_ONLY,
  LITERAL_PROJECT_RULES as LITERAL,
  pickerProject,
  STEP_PROJECT_RULES as STEP,
} from './node-project-resolution';

const LOCAL = [
  { id: 'id-api', name: 'api' },
  { id: 'id-web-1', name: 'web' },
  { id: 'id-web-2', name: 'web' },
];

describe('getEffectiveNodeProjectId', () => {
  it('uses trimmed block projectId when non-empty', () => {
    expect(getEffectiveNodeProjectId('  pid-1  ', undefined)).toBe('pid-1');
    expect(getEffectiveNodeProjectId('pid-2', 'default-id')).toBe('pid-2');
  });

  it('falls back to flow default when block project is blank', () => {
    expect(getEffectiveNodeProjectId('', 'default-uuid')).toBe('default-uuid');
    expect(getEffectiveNodeProjectId('   ', '  spaced-default  ')).toBe('spaced-default');
  });

  it('returns undefined when neither block nor default is usable', () => {
    expect(getEffectiveNodeProjectId('', undefined)).toBeUndefined();
    expect(getEffectiveNodeProjectId('   ', '')).toBeUndefined();
  });
});

describe('classifyProjectRef', () => {
  it('resolves an id, and a name only one project has', () => {
    expect(classifyProjectRef('id-api', LOCAL, STEP)).toBe('ok');
    expect(classifyProjectRef(' api ', LOCAL, STEP)).toBe('ok');
  });

  it('calls a name two projects share ambiguous, as dispatch does', () => {
    expect(classifyProjectRef('web', LOCAL, STEP)).toBe('ambiguous');
  });

  it('flags an id or name that is not on this computer', () => {
    expect(classifyProjectRef('deleted-id', LOCAL, STEP)).toBe('unknown');
  });

  it('never flags a template', () => {
    expect(classifyProjectRef('{{trigger.project}}', LOCAL, STEP)).toBe('ok');
  });

  it('flags a stray brace that dispatch would refuse as malformed', () => {
    expect(classifyProjectRef('{{trigger.project', LOCAL, STEP)).toBe('malformed');
    expect(classifyProjectRef('api}', LOCAL, STEP)).toBe('malformed');
  });

  it('never renders the flow default, so a template there is unknown', () => {
    expect(classifyProjectRef('{{trigger.project}}', LOCAL, LITERAL)).toBe('unknown');
    expect(classifyProjectRef('api', LOCAL, LITERAL)).toBe('ok');
  });

  it('matches ids only for custom nodes, so a name or template is unknown', () => {
    expect(classifyProjectRef('id-api', LOCAL, ID_ONLY)).toBe('ok');
    expect(classifyProjectRef('api', LOCAL, ID_ONLY)).toBe('unknown');
    expect(classifyProjectRef('{{trigger.project}}', LOCAL, ID_ONLY)).toBe('unknown');
  });

  it('skips the check while the project list is unavailable', () => {
    expect(classifyProjectRef('anything', null, STEP)).toBe('ok');
  });

  it('reports a blank value as missing even before the list loads', () => {
    expect(classifyProjectRef('   ', null, STEP)).toBe('missing');
  });
});

describe('getNodeProjectFieldError', () => {
  it('is null when the project resolves', () => {
    expect(getNodeProjectFieldError('id-api', undefined, LOCAL, STEP)).toBeNull();
  });

  it('asks for a project when neither the step nor the flow has one', () => {
    expect(getNodeProjectFieldError('', undefined, LOCAL, STEP)).toBe('Select a project.');
  });

  it('names a project that is not on this computer', () => {
    expect(getNodeProjectFieldError('mobile', undefined, LOCAL, STEP)).toBe(
      "The project “mobile” isn't on this computer. Pick a project.",
    );
  });

  it('names a project two local projects share', () => {
    expect(getNodeProjectFieldError('web', undefined, LOCAL, STEP)).toBe(
      'More than one project is named “web”. Pick one.',
    );
  });

  it('says a broken variable is broken', () => {
    expect(getNodeProjectFieldError('{{trigger.project', undefined, LOCAL, STEP)).toBe(
      "“{{trigger.project” isn't a valid variable. Fix it or pick a project.",
    );
  });

  it('checks the inherited flow default literally, even on a step that takes templates', () => {
    expect(getNodeProjectFieldError('', '{{trigger.project}}', LOCAL, STEP)).toBe(
      "The project “{{trigger.project}}” isn't on this computer. Pick a project.",
    );
  });
});

describe('pickerProject', () => {
  const rows = [{ id: 'id-api', name: 'api', path: '/code/api' }];

  it('shows an imported name as the one project it resolves to', () => {
    expect(pickerProject('api', rows, STEP)).toEqual(rows[0]);
  });

  it('shows an unresolved value in full, not a truncated id', () => {
    expect(pickerProject('api', rows, ID_ONLY)).toEqual({ id: 'api', name: 'api', path: '' });
  });
});
