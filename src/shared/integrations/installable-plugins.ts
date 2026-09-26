/**
 * Which builtin ids each lifecycle branch accepts.
 * Shared because both the main-process lifecycle (zod input enums) and the
 * renderer's lifecycle affordances narrow on the same predicates.
 */
import { PLUGIN_DEFINITIONS } from './plugins';
import { vendorPluginPin } from './vendor-plugin-pins';

/** A plugin whose install IS the chat consent: an http MCP server behind it (catalog folders, and PostHog with its trigger row). */
export function isMcpPluginId(value: string): boolean {
  const definition = PLUGIN_DEFINITIONS.find((candidate) => candidate.id === value);
  return (
    definition?.contents.mcpServers.some((server) => server.transport.type === 'http') === true
  );
}

/** A builtin with an inbound webhook and no MCP consent to perform. */
export function isWebhookPluginId(value: string): boolean {
  const definition = PLUGIN_DEFINITIONS.find((candidate) => candidate.id === value);
  return (
    definition?.availability === 'available' &&
    definition.provider !== undefined &&
    !isMcpPluginId(value) &&
    !vendorPluginPin(value)
  );
}

/** Every builtin accepted by the shared install, pause and remove controls. */
export function isInstallablePluginId(value: string): boolean {
  return isMcpPluginId(value) || isWebhookPluginId(value) || Boolean(vendorPluginPin(value));
}
