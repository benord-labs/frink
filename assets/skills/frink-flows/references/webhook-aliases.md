## Friendly webhook aliases (`{{trigger.<alias>}}`)

For supported providers, prefer these readable aliases over raw `{{trigger.payload.*}}` paths — they are shorter, validated in the editor, and stable across payload shape changes. An absent field renders empty (never a literal `{{...}}`). Unlisted providers: use `{{trigger.payload.*}}` (the raw webhook body).

### clickup
| alias | type | from (raw payload path) | description |
|-------|------|-------------------------|-------------|
| `{{trigger.task.id}}` | string | `task_id` | Task ID |
| `{{trigger.webhook.id}}` | string | `webhook_id` | Webhook ID |
| `{{trigger.action}}` | string | `event` | Event |

### shortcut
| alias | type | from (raw payload path) | description |
|-------|------|-------------------------|-------------|
| `{{trigger.story.title}}` | string | `actions.0.name` | Story title |
| `{{trigger.story.id}}` | number | `primary_id` | Story ID |
| `{{trigger.story.url}}` | string | `actions.0.app_url` | Story URL |
| `{{trigger.story.action}}` | string | `actions.0.action` | create / update |

### linear
| alias | type | from (raw payload path) | description |
|-------|------|-------------------------|-------------|
| `{{trigger.issue.title}}` | string | `data.title` | Issue title |
| `{{trigger.issue.id}}` | string | `data.issueId` or `data.id` | Issue ID |
| `{{trigger.issue.identifier}}` | string | `data.identifier` | Issue key |
| `{{trigger.issue.url}}` | string | `url` | Issue URL |
| `{{trigger.issue.description}}` | string | `data.description` | Description |
| `{{trigger.issue.priority}}` | string | `data.priorityLabel` | Priority |
| `{{trigger.comment.body}}` | string | `data.body` | Comment body |
| `{{trigger.action}}` | string | `action` | Action |
