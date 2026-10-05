import { describe, expect, it } from 'vitest';
import { getTemplateRenderedFields } from './template-rendered-fields';

describe('getTemplateRenderedFields', () => {
  it('lists projectId so a run can be routed to a project resolved at run time', () => {
    expect(getTemplateRenderedFields('start_task', {})).toContain('projectId');
    expect(getTemplateRenderedFields('run_command', {})).toContain('projectId');
    // agent takes its project from the upstream start_task's outputs, and custom-node dispatch
    // reads projectId statically — a template in either would be inert.
    expect(getTemplateRenderedFields('agent', {})).not.toContain('projectId');
    expect(
      getTemplateRenderedFields('check-new-prs', { projectId: '{{trigger.project}}' }),
    ).not.toContain('projectId');
  });

  it('selects only the active chat_reply variant fields', () => {
    expect(getTemplateRenderedFields('chat_reply', { messageTemplate: 'Hello' })).toEqual([
      'messageTemplate',
    ]);
    expect(
      getTemplateRenderedFields('chat_reply', {
        contentType: 'html_artifact',
        artifactTitleTemplate: 'Report',
        artifactBodyHtmlTemplate: '<p>Done</p>',
        messageTemplate: 'stale hidden field',
      }),
    ).toEqual(['artifactTitleTemplate', 'artifactBodyHtmlTemplate']);
  });

  it('drops custom-node inputs the manifest declares "template": false (sc-3251)', () => {
    const config = { query: '{{field}}', repo: '{{trigger.repo}}' };
    expect(getTemplateRenderedFields('check-new-prs', config)).toEqual(['query', 'repo']);
    expect(
      getTemplateRenderedFields('check-new-prs', config, { query: { template: false } }),
    ).toEqual(['repo']);
  });
});
