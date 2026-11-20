import { z } from 'zod';

const mcpFailureSchema = z.object({
  error: z.object({ message: z.string() }).nullish().catch(null),
  result: z
    .object({ content: z.array(z.object({ text: z.string().optional() })) })
    .nullish()
    .catch(null),
});

/** Why an `mcpToolCall` item failed: a transport error, or a result the tool marked isError,
 * which the app-server reports as status 'failed' with the result set. Undefined on success. */
export function mcpCallError(item: Record<string, unknown>): string | undefined {
  const { error, result } = mcpFailureSchema.parse(item);
  if (error) return error.message;
  if (item.status !== 'failed') return undefined;
  const text = result?.content
    .map((block) => block.text ?? '')
    .join('\n')
    .trim();
  return text || 'The tool call failed.';
}
