/**
 * Shared template variable constants for Frink Flows.
 *
 * Used by:
 * - src/shared/lib/validate-flow-templates.ts (design-time static analysis, MCP)
 */

/**
 * Regex for matching `{{path.to.value}}` template placeholders.
 * Matches the exact same pattern as the runtime renderer in template-utils.ts.
 * Must NOT use the `g` flag on the shared instance — callers construct their own
 * instances (or use `new RegExp(TEMPLATE_VARIABLE_PATTERN, 'g')`) to avoid
 * shared regex lastIndex state issues.
 */
export const TEMPLATE_VARIABLE_PATTERN = '\\{\\{([^{}]+)\\}\\}';
