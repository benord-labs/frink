/**
 * `frink_flows_list_catalog` kind: 'integrations' — the user's connected integrations,
 * for wiring a webhook_trigger node.
 */

import { getEventTypes } from '../../../../../shared/integrations/selectors';
import { getDatabase } from '../../../db';
import { captureMainMessage } from '../../../sentry/init';
import { localIntegrationRows } from '../../../webhooks/local-endpoints';
import { type McpToolResult, toolResult } from '../../tool-result';

export async function handleIntegrationsList(): Promise<McpToolResult> {
  try {
    const rows = await localIntegrationRows(getDatabase());
    // Explicit slim allowlist — never spread the raw row. Only id / provider / account / event ids
    // reach the agent.
    const integrations = rows
      .filter((r) => r.isActive)
      .map((r) => ({
        id: r.id,
        provider: r.provider,
        // Truthy fallback (not ??): an empty accountName must yield the identifier, matching the
        // renderer's WebhookTriggerConfig logic — else same-provider accounts render indistinguishably blank.
        account: r.accountName || r.accountIdentifier,
        events: getEventTypes(r.provider).map((e) => ({ id: e.id, label: e.label })),
      }));

    if (integrations.length === 0) {
      return toolResult(
        JSON.stringify(
          {
            integrations: [],
            message:
              'No integrations connected. Tell the user to connect one in Settings → Plugins, then retry. Do not invent an integration id.',
          },
          null,
          2,
        ),
      );
    }

    return toolResult(JSON.stringify({ integrations }, null, 2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The agent only sees plain words, so a failed read is otherwise invisible.
    captureMainMessage(`Integrations catalog read failed: ${message}`, 'warning', {
      surface: 'frink_flows_list_catalog',
      kind: 'integrations',
    });
    return toolResult(`Failed to list integrations: ${message}`, true);
  }
}
