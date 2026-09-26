import { PLUGIN_DEFINITIONS } from '../../../../shared/integrations/plugins';
import { CLAUDE_CODE_MODELS, CODEX_MODELS } from '../../../../shared/lib/models';

/** `autonomous_bugs` → `Autonomous bugs`. */
function readable(raw: string): string {
  const spaced = raw.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** An MCP server's integration name: `plugin_<plugin>_<server>` and the vendor's own server both read
 * as the plugin. Display only; the prefix is ambiguous, so the longest matching plugin id wins. */
export function integrationLabel(server: string): string {
  const plugin = PLUGIN_DEFINITIONS.filter(
    (p) => server === p.id || server.startsWith(`plugin_${p.id}_`),
  ).sort((a, b) => b.id.length - a.id.length)[0];
  if (plugin) return plugin.name;
  // Plugin names are hyphenated slugs, so an unknown plugin's name ends at the first underscore.
  return readable(server.startsWith('plugin_') ? server.slice(7).split('_')[0] : server);
}

/** `claude-opus-5` → `Opus 5`, from the model catalogs; else a Claude API id read as family and
 * version (`claude-haiku-4-5-20251001` → `Haiku 4.5`), else the id made readable. */
export function modelLabel(model: string): string {
  const known = [...CLAUDE_CODE_MODELS, ...CODEX_MODELS].find(
    (m) => m.cliValue === model || m.id === model,
  );
  if (known) return known.familyName;
  const claude = /^claude-([a-z]+)((?:-\d+)+?)(?:-\d{8})?$/.exec(model);
  return claude
    ? `${readable(claude[1])} ${claude[2].slice(1).replaceAll('-', '.')}`
    : readable(model);
}
