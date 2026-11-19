import type http from 'node:http';
import { z } from 'zod';
import { serveScripted, streamEvents } from '../../../agent-runner/acp/agents/admission-model';

const Tool = z.looseObject({ type: z.string() });
/** The parts of a Responses request the scripted model reads. Codex offers its tools as an input item. */
const ResponsesRequest = z.looseObject({
  tools: z.array(Tool).default([]),
  input: z.array(z.looseObject({ type: z.string(), tools: z.array(Tool).optional() })).default([]),
});

const USAGE = {
  input_tokens: 1,
  input_tokens_details: null,
  output_tokens: 1,
  output_tokens_details: null,
  total_tokens: 2,
};
const SEARCH = { type: 'tool_search_call', call_id: 'call_search', execution: 'client' };
const DONE = { type: 'message', role: 'assistant', id: 'msg_done' };

function reply<Item extends { type: string }>(res: http.ServerResponse, item: Item): void {
  streamEvents(res, [
    { type: 'response.created', response: { id: 'resp_scripted' } },
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { id: 'resp_scripted', usage: USAGE } },
  ]);
}

/** A Responses-API model on 127.0.0.1 that keeps every request body. It first searches the
 * deferred tools when offered, so MCP tool names reach the next request, then says "done". */
export async function startScriptedResponsesModel() {
  const requests: string[] = [];
  const answer = (url: string, body: string, res: http.ServerResponse) => {
    if (!/\/responses(\?|$)/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    requests.push(body);
    const { tools, input } = ResponsesRequest.parse(JSON.parse(body || '{}'));
    const offered = [...tools, ...input.flatMap((item) => item.tools ?? [])];
    const searched = input.some((item) => item.type === 'tool_search_output');
    if (!searched && offered.some((tool) => tool.type === 'tool_search')) {
      return reply(res, { ...SEARCH, arguments: { query: 'frink canary' } });
    }
    reply(res, { ...DONE, content: [{ type: 'output_text', text: 'done' }] });
  };
  const { server, port } = await serveScripted(answer);
  return { url: `http://127.0.0.1:${port}/v1`, requests, server };
}
