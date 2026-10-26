import http from 'node:http';
import type net from 'node:net';
import { z } from 'zod';

/** One tool call the scripted model makes. */
export type Step = { tool: string; args: Record<string, string> };

export function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(z.object({ port: z.number() }).parse(server.address()).port);
    });
  });
}

/** A server on 127.0.0.1 that hands `answer` each request's path and whole body. */
export async function serveScripted(
  answer: (url: string, body: string, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (part) => (body += part));
    req.on('end', () => answer(req.url ?? '', body, res));
  });
  return { server, port: await listen(server) };
}

/** Streams named server-sent events, the framing of the Anthropic and Responses APIs. */
export function streamEvents<Event extends { type: string }>(
  res: http.ServerResponse,
  events: Event[],
): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

function sse(res: http.ServerResponse, deltas: object[]) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  deltas.forEach((delta, index) => {
    const finish = index === deltas.length - 1 ? (index === 0 ? 'stop' : 'tool_calls') : null;
    const choice = { index: 0, delta, finish_reason: finish };
    res.write(
      `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', choices: [choice] })}\n\n`,
    );
  });
  res.end('data: [DONE]\n\n');
}

/** The parts of a chat request the scripted model reads. */
const ModelRequest = z.looseObject({
  messages: z.array(z.looseObject({ role: z.string() })).default([]),
  tools: z.array(z.json()).default([]),
});

function toolCall(step: Step, index: number) {
  const call = { name: step.tool, arguments: JSON.stringify(step.args) };
  return { index: 0, id: `call_${index}`, type: 'function', function: call };
}

/**
 * An OpenAI-compatible model on 127.0.0.1 for admission runs. A prompt names its case as
 * `case:<id>`; the model plays that case's tool calls in order, then says it is done.
 */
export async function startScriptedModel() {
  const scripts = new Map<string, Step[]>();
  const requests = new Map<string, string[]>();
  const answer = (body: string, res: http.ServerResponse) => {
    const { messages, tools } = ModelRequest.parse(JSON.parse(body || '{}'));
    if (tools.length === 0) return sse(res, [{ role: 'assistant', content: 'Admission case' }]);
    const id = /case:([a-z0-9-]+)/.exec(JSON.stringify(messages))?.[1] ?? '';
    requests.set(id, [...(requests.get(id) ?? []), body]);
    const done = messages.filter((message) => message.role === 'tool').length;
    const step = scripts.get(id)?.[done];
    if (!step) return sse(res, [{ role: 'assistant', content: 'done' }]);
    return sse(res, [{ role: 'assistant', tool_calls: [toolCall(step, done + 1)] }, {}]);
  };
  const { server, port } = await serveScripted((_url, body, res) => answer(body, res));
  return { url: `http://127.0.0.1:${port}/v1`, scripts, requests, server };
}

/** A tool module that leaves a marker when anything loads it. */
export const markerModule = (marker: string) =>
  `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "loaded");\nexport default { description: "x", args: {}, async execute() { return "ok"; } };\n`;
