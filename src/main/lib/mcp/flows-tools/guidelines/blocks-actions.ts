import { buildOutputSchemasSection } from './schema-tables';

export function getBlocksActionsGuideline(): string {
  return `# Action contracts

Config below is inside \`node.config\`; \`?\` means optional. Output tables are generated from the runtime schema. Outputs replace predecessor data; put Start Task before producing data another block needs.

## start_task

Creates the task/chat and execution environment required before an \`agent\`.

\`\`\`text
{ projectId?: string, label?: string, model?: string,
  startMode?: "execute"|"plan"|"wait", startInWorktree?: boolean, branch?: string }
\`\`\`

\`projectId\` accepts id/exact name/templates, otherwise flow \`defaultProjectId\`. Worktrees default off: set \`startInWorktree: true\` for branch chaining. \`branch\` is an existing branch to branch FROM, not the new worktree branch name.

${buildOutputSchemasSection('start_task')}

## agent

Inherits the upstream Start Task; another Agent follows up in the same task.

\`\`\`text
{ instructions: string, fireAndForget?: boolean, model?: string,
  mode?: "agent"|"plan"|"debug", autoApprove?: boolean, agentInstructions?: string }
\`\`\`

\`model\`/\`mode\` override inherited settings for this node only. Plan mode pauses for approval unless \`autoApprove: true\`; debug is local-only and pauses for human reproduction. \`agentInstructions\` supplies a templated role above the task instructions; the briefing arrives separately in the session system prompt. \`instructions\` and \`agentInstructions\` are each limited to 50,000 characters (trimmed): a patch over the limit is rejected, and one at 40,000 or more returns a warning.
A leading \`/command\` in instructions expands at save time. Discover names with \`frink_flows_list_catalog({kind:"commands"})\`; unknown commands reject the patch, built-ins such as \`/plan\` stay literal. Expansion sets \`instructionsCommandName\` automatically; do not set it manually.

${buildOutputSchemasSection('agent')}

## run_command

\`\`\`text
{ command: string, projectId?: string,
  workingDirectory?: "project_root"|"trigger_worktree"|"custom", customPath?: string,
  expectedOutputs?: { [key: string]: { type: "string"|"number"|"boolean"|"object"|"array", description?: string } } }
\`\`\`

\`customPath\` is required for \`custom\`. Leave templates bare (\`echo prefix {{previous.summary}}\`): Frink shell-escapes values. Put logs on stderr and emit one JSON object on stdout. Its top-level keys become outputs; nested keys use dot paths. Invalid/mixed stdout falls back to \`_rawStdout\`; \`expectedOutputs\` documents JSON fields for chips/validation and does not create values.

\`\`\`json
{"id":"count","blockType":"run_command","config":{"command":"printf '{\\"count\\":3}'","expectedOutputs":{"count":{"type":"number"}}}}
\`\`\`

${buildOutputSchemasSection('run_command')}

## http_request

\`\`\`text
{ url: string, method?: "GET"|"POST"|"PUT"|"PATCH"|"DELETE",
  headers?: Record<string,string>, body?: string }
\`\`\`

Method defaults GET; body is not sent for GET.

${buildOutputSchemasSection('http_request')}

## chat_reply

Requires a chat on the same path: an upstream Start Task or \`post_task_trigger\` with \`trigger.chatId\`.

\`\`\`text
{ contentType?: "text"|"html_artifact", messageTemplate?: string,
  artifactTitleTemplate?: string, artifactBodyHtmlTemplate?: string }
\`\`\`

Text (default) requires \`messageTemplate\`. HTML requires title + HTML body fragment; the user explicitly opens an isolated view. Charts need labels and a text/table alternative. \`manual_trigger → run_command → chat_reply\` lacks a chat; insert Start Task **before** the command to preserve its outputs.

${buildOutputSchemasSection('chat_reply')}

## Connected integration steps

Discover rather than guess: \`frink_flows_list_catalog({kind:"nodes"})\` returns installed steps/config; add \`pluginId\` for live tools. If it returns a vocabulary, add \`search\`; exact tool-name search returns its argument schema. Unknown step names may save then fail at run time. These steps are machine-owned; do not register them yourself.
Use the returned step name as \`blockType\`, inputs as \`config\`, and optional \`connectionId\` to pin an account. Prefer a named step; a \`callTool: true\` / \`<integration>_call_tool\` step takes \`{tool, arguments?}\` for that server's actual tools. Outputs are \`text\`, \`result\`, and optional \`structured\`; other steps declare their own. Refused calls fail the step. Vendor \`readOnly\`/\`destructive\` labels are descriptions, not permissions.
`;
}
