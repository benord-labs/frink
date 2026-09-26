import log from 'electron-log';
import { z } from 'zod';
import { codexProjectionDir, listStagedVendorPlugins } from './index';
import { readPluginJson } from './package-files';

/** An http MCP server a staged plugin ships, read from its codex projection. */
export type VendorPluginDeclaredMcpServer = {
  pluginName: string;
  serverKey: string;
  url: string;
};

const serversSchema = z.record(
  z.string(),
  z.object({ type: z.string().optional(), url: z.string().optional() }),
);
const declaredMcpServersSchema = z.object({
  mcpServers: z.union([serversSchema, z.string()]).optional(),
});
type DeclaredMcpServers = z.infer<typeof serversSchema>;

/**
 * HTTP servers shipped by the native Codex package, then Claude declarations for parity.
 * A broken explicit declaration fails closed; stdio and headersHelper are never executed.
 */
export async function listStagedVendorPluginMcpServers(): Promise<VendorPluginDeclaredMcpServer[]> {
  const out = await Promise.all(
    listStagedVendorPlugins().map(async (p) => {
      const projection = codexProjectionDir(p);
      let declared: DeclaredMcpServers | undefined;
      for (const relative of [
        '.codex-plugin/plugin.json',
        '.claude-plugin/plugin.json',
        '.mcp.json',
      ]) {
        const result = await declaredMcpServersFrom(projection, relative);
        if (result === 'invalid') return [];
        declared = result;
        if (declared && Object.keys(declared).length > 0) break;
      }
      return Object.entries(declared ?? {}).flatMap(([serverKey, server]) => {
        // The declared type wins over shape: {"type":"stdio","url":...} is a
        // stdio server that happens to carry a url, not an HTTP server.
        const httpType =
          server.type === undefined || server.type === 'http' || server.type === 'sse';
        // A stdio entry's empty/absent url must not drop the http servers beside it.
        return httpType && server.url ? [{ pluginName: p.name, serverKey, url: server.url }] : [];
      });
    }),
  );
  return out.flat();
}

/** `undefined` = absent; `invalid` = broken explicit declaration (must not fall through). */
async function declaredMcpServersFrom(
  root: string,
  relative: string,
): Promise<DeclaredMcpServers | undefined | 'invalid'> {
  try {
    const raw = await readPluginJson(root, relative);
    if (raw === undefined) return undefined;
    const declared = declaredMcpServersSchema.parse(raw).mcpServers;
    // A manifest without the key declares nothing; only a broken declaration fails closed.
    if (declared === undefined) return undefined;
    const path = z.string().safeParse(declared);
    if (!path.success) return serversSchema.parse(declared);
    const referenced = await readPluginJson(root, path.data);
    // Referenced files must exist and contain a servers object, not another path.
    return z.object({ mcpServers: serversSchema }).parse(referenced).mcpServers;
  } catch (error) {
    log.warn(`[VendorPluginMcp] invalid declaration ${relative}: ${String(error)}`);
    return 'invalid';
  }
}
