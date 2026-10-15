// Runs Cursor's SDK for one Frink turn, in its own process with the private HOME Frink gave it.
// Its only argument is the SDK's entry; it talks to Frink by message and exits only on cancel.
import { pathToFileURL } from 'node:url';

const port = process.parentPort;
const post = (message) => (port ? port.postMessage(message) : process.send(message));
let sdk;
let agent;
let run;

const fail = (error) => post({ type: 'error', text: String(error?.message ?? error), code: error?.code });

async function openAgent({ options, resumeAgentId }) {
  const { storeDir, ...rest } = options;
  const agentOptions = { ...rest, local: { ...rest.local, store: new sdk.JsonlLocalAgentStore(storeDir) } };
  if (resumeAgentId) {
    const resumed = await sdk.Agent.resume(resumeAgentId, agentOptions).catch(() => undefined);
    if (resumed) return { opened: resumed, resumed: true };
  }
  return { opened: await sdk.Agent.create(agentOptions), resumed: false };
}

// A resume that had to open a new agent sends the earlier history instead of the bare prompt.
const promptText = ({ resumeAgentId, fallbackText, message }, resumed) =>
  resumeAgentId && !resumed ? (fallbackText ?? message.text) : message.text;

async function start(request) {
  const { opened, resumed } = await openAgent(request);
  agent = opened;
  post({ type: 'agent', agentId: agent.agentId, resumed });
  const sendOptions = request.mode ? { mode: request.mode } : undefined;
  run = await agent.send({ ...request.message, text: promptText(request, resumed) }, sendOptions);
  for await (const message of run.stream()) post({ type: 'sdk', message });
  const { status, error } = await run.wait();
  post({ type: 'result', status, error: error && { message: error.message, code: error.code } });
}

async function listModels() {
  const list = await sdk.Cursor.models.list();
  post({ type: 'models', list: list.map(({ id, displayName }) => ({ id, displayName })) });
}

async function cancel() {
  await run?.cancel().catch(() => {});
  try {
    agent?.close();
  } finally {
    process.exit(0);
  }
}

function onRequest(request) {
  if (request.type === 'cancel') return void cancel();
  void (request.type === 'start' ? start(request) : listModels()).catch(fail);
}

if (port) port.on('message', (event) => onRequest(event.data));
else process.on('message', onRequest).on('disconnect', () => process.exit(0));

try {
  sdk = await import(pathToFileURL(process.argv.at(-1)).href);
  // Runs sign in with the user's own key first, so it counts as signed in.
  const status = process.env.CURSOR_API_KEY ? 'logged-in' : (await sdk.Cursor.auth.status()).status;
  post({ type: 'auth', status });
} catch (error) {
  fail(error);
}
