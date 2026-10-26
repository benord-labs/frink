import type http from 'node:http';
import { z } from 'zod';
import { serveScripted, streamEvents } from '../../../agent-runner/acp/agents/admission-model';

/** The parts of a Messages request the scripted model reads. */
const MessagesRequest = z.looseObject({
  model: z.string().default('scripted'),
  stream: z.boolean().optional(),
  tools: z.array(z.json()).default([]),
});

const REPLY = 'done';
const USAGE = { input_tokens: 1, output_tokens: 1 };

function message(model: string, stopped: boolean) {
  const content = stopped ? [{ type: 'text', text: REPLY }] : [];
  const stop_reason = stopped ? 'end_turn' : null;
  return { id: 'msg_scripted', type: 'message', role: 'assistant', model, content, stop_reason };
}

function streamReply(res: http.ServerResponse, model: string): void {
  streamEvents(res, [
    { type: 'message_start', message: { ...message(model, false), usage: USAGE } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: REPLY } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: USAGE },
    { type: 'message_stop' },
  ]);
}

function json<Body>(res: http.ServerResponse, body: Body): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** An Anthropic Messages model on 127.0.0.1 that says "done". It keeps the body of every request
 * the agent loop makes (one that offers tools); any other route gets `{}`. */
export async function startScriptedAnthropicModel() {
  const requests: string[] = [];
  const answer = (url: string, body: string, res: http.ServerResponse) => {
    if (url.includes('/count_tokens')) return json(res, { input_tokens: 1 });
    if (!/\/messages(\?|$)/.test(url)) return json(res, {});
    const { model, stream, tools } = MessagesRequest.parse(JSON.parse(body || '{}'));
    if (tools.length > 0) requests.push(body);
    if (stream) return streamReply(res, model);
    json(res, { ...message(model, true), usage: USAGE });
  };
  const { server, port } = await serveScripted(answer);
  return { url: `http://127.0.0.1:${port}`, requests, server };
}
