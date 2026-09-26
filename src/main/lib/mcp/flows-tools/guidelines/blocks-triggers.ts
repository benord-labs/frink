import { buildTriggerSchemasSection } from './schema-tables';

export function getBlocksTriggersGuideline(): string {
  return `# Trigger contracts

Exactly one trigger; one outgoing edge and no incoming edge. Triggers supply \`trigger.*\`, not \`previous.*\`. Batch runs bypass the trigger and use per-run \`triggerContext\` instead.

## manual_trigger

Config \`{}\`. Starts from Run in the app or an authorized MCP run. Accepts caller-defined triggerContext keys such as ticketId. Set label/customInstructions and a root batch's baseBranch as needed; dependency branch fields are injected at dispatch for dependent stages.

${buildTriggerSchemasSection('manual_trigger')}

## post_task_trigger

Config \`{}\`; bound at flow level to a project, fires on task completion. Carries chat context for replies; a new agent task still needs Start Task. Use trigger fields to read the completed task after that new Start Task.

${buildTriggerSchemasSection('post_task_trigger')}

## schedule_trigger

Config \`{ cronExpression: string, timezone: string }\`. Standard five-field cron, e.g. \`"0 9 * * *"\`, with explicit timezone such as \`"UTC"\`. A schedule carries no chat; create Start Task before a reply.

${buildTriggerSchemasSection('schedule_trigger')}

## webhook_trigger

Config \`{ integrationId: string, eventType: string, conditions?: object }\`.
First call \`frink_flows_list_catalog({kind:"integrations"})\`; choose a returned integration id and one of its \`events[].id\` values (not label). Those two fields are the complete binding; no separate trigger rule. Empty catalog/sign-out: ask the user to connect an integration, do not invent ids. The provider must deliver webhooks; endpoint generation/verification may still be needed in Settings → Plugins.

Stored \`eventType\`/\`fullContent\` are aliased to \`event\`/\`payload\` at runtime. Prefer friendly provider aliases from \`webhook-aliases.md\`; unlisted providers use raw \`trigger.payload.*\`.

${buildTriggerSchemasSection('webhook_trigger')}
`;
}
