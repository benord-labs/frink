/**
 * Optional starter text for Agent block instructions. Users insert via the flow editor;
 * content uses `{{trigger.*}}` variables resolved at run time (see buildFlowTemplateVariables
 * + provider-trigger-aliases). Friendly per-provider aliases ({{trigger.story.title}} etc.)
 * map onto the raw webhook body — see `src/shared/integrations/trigger-field-aliases.ts`.
 */

export type RecommendedAgentPromptTemplate = {
  id: string;
  label: string;
  /** When set, template is suggested first for this integration source (shortcut, gmail, etc.) */
  suggestedForSources?: string[];
  body: string;
};

export const RECOMMENDED_AGENT_PROMPT_TEMPLATES: RecommendedAgentPromptTemplate[] = [
  {
    id: 'shortcut-story',
    label: 'Shortcut story (recommended)',
    suggestedForSources: ['shortcut'],
    body: `## Trigger Context: Shortcut Story

<task_identity>
You are handling a trigger-generated Shortcut task. Treat metadata as context and execute the explicit request.
</task_identity>

<trigger_summary>
- Story: {{trigger.story.title}}
- Story ID: {{trigger.story.id}}
- Link: {{trigger.story.url}}
- Event: {{trigger.event}}
- Triggered at: {{trigger.timestamp}}
</trigger_summary>

<supporting_context>
Full raw webhook payload (JSON) — read it for any field not surfaced above:
\`\`\`json
{{trigger.payload}}
\`\`\`
</supporting_context>

<execution_request>
**What the user expects**:
- This is a feature request or bug fix from your project management tool.
- Focus on implementing the story requirements.
- Write production-quality code with appropriate tests.
- Follow the project's architecture and coding standards.
- Create a git worktree if you'll be making code changes.
- When done, ensure changes are ready for code review.
</execution_request>

<final_checklist>
- Confirm delivered changes.
- List any remaining work or blockers.
</final_checklist>`,
  },
  {
    id: 'gmail-email',
    label: 'Gmail (recommended)',
    suggestedForSources: ['gmail'],
    body: `## Trigger Context: Email

<task_identity>
You are handling a trigger-generated email task. Use the trigger context for signal, then execute the explicit request.
</task_identity>

<trigger_summary>
- Subject: {{trigger.email.subject}}
- From: {{trigger.email.from}}
- Preview: {{trigger.email.preview}}
- Event: {{trigger.event}}
- Triggered at: {{trigger.timestamp}}
</trigger_summary>

<supporting_context>
Full normalized email payload (JSON):
\`\`\`json
{{trigger.payload}}
\`\`\`
</supporting_context>

<execution_request>
**What the user expects**:
- This is an email that requires action or analysis.
- Do not draft a reply email unless explicitly requested.
- Extract actionable items and execute what is feasible now.
- If external assets are required, state exactly what is missing.
</execution_request>

<final_checklist>
- Confirm what was done.
- Call out blockers or missing inputs.
- Keep output concise and action-oriented.
</final_checklist>`,
  },
  {
    id: 'generic-webhook',
    label: 'Generic webhook',
    suggestedForSources: ['github', 'slack', 'clickup'],
    body: `## Trigger Context

<task_identity>
You are handling a trigger-generated task with webhook metadata.
</task_identity>

<trigger_summary>
- Source: {{trigger.source}}
- Event: {{trigger.event}}
- Triggered at: {{trigger.timestamp}}
</trigger_summary>

<supporting_context>
Full raw webhook payload (JSON):
\`\`\`json
{{trigger.payload}}
\`\`\`
Friendly fields are also available per provider — see "Available variables" (e.g.
{{trigger.item.title}} for GitHub, {{trigger.task.id}} for ClickUp, {{trigger.message.text}} for Slack).
</supporting_context>

<execution_request>
**What the user expects**:
- Use this trigger context to complete the requested task.
- Follow project rules and keep work in scope.
</execution_request>`,
  },
];
