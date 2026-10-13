import type {
  ClientConnection,
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from '@agentclientprotocol/sdk';
import log from 'electron-log';

/** Starting an agent may include a first-run download; a prompt itself has no deadline. */
const START_DEADLINE_MS = 60_000;

/** What a turn asks of the session it runs in. */
type AcpSessionInputs = {
  agentId: string;
  agentName: string;
  cwd: string;
  resumeSessionId?: string;
  model?: string;
  mode?: string;
  hasImages: boolean;
};

type OpenedSession = {
  sessionId: string;
  /** The earlier session could not be continued, so the agent starts without its history. */
  lostHistory: boolean;
};

type ModelOption = { id: string; name: string };

const modelOptionsByAgent = new Map<string, ModelOption[]>();

/** The models an agent listed in the last session it opened, if it has opened one. */
export function rememberedModelOptions(agentId: string): ModelOption[] | undefined {
  return modelOptionsByAgent.get(agentId);
}

/** The values of the session's list setting of `category`, such as `model` or `mode`. */
function listSetting(options: SessionConfigOption[], category: string) {
  for (const option of options) {
    if (option.type !== 'select' || option.category !== category) continue;
    const entries: (SessionConfigSelectOption | SessionConfigSelectGroup)[] = option.options;
    const values = entries.flatMap((entry) => ('group' in entry ? entry.options : [entry]));
    return { configId: option.id, values };
  }
  return undefined;
}

/** Sets a list setting to `value`, refusing with `refusal` when the session does not offer it. */
async function choose(
  connection: ClientConnection,
  sessionId: string,
  options: SessionConfigOption[],
  setting: { category: string; value: string; refusal: string },
): Promise<SessionConfigOption[]> {
  const listed = listSetting(options, setting.category);
  if (!listed?.values.some(({ value }) => value === setting.value)) {
    throw new Error(setting.refusal);
  }
  const { configId } = listed;
  const changed = await connection.agent.request('session/set_config_option', {
    sessionId,
    configId,
    value: setting.value,
  });
  return changed.configOptions;
}

/** Continues the earlier session when the agent can, else opens a new one. */
async function resumeOrCreate(
  connection: ClientConnection,
  inputs: AcpSessionInputs,
  canResume: boolean,
) {
  const { resumeSessionId, cwd } = inputs;
  if (resumeSessionId && canResume) {
    try {
      const resumed = await connection.agent.request('session/resume', {
        sessionId: resumeSessionId,
        cwd,
        mcpServers: [],
      });
      return { sessionId: resumeSessionId, options: resumed.configOptions, lostHistory: false };
    } catch (error) {
      log.warn('[ACP] Could not continue the earlier session; starting a new one', error);
    }
  }
  const created = await connection.agent.request('session/new', { cwd, mcpServers: [] });
  const lostHistory = resumeSessionId !== undefined;
  return { sessionId: created.sessionId, options: created.configOptions, lostHistory };
}

/** Remembers the session's models, then sets the chosen mode and model. */
async function applyChoices(
  connection: ClientConnection,
  sessionId: string,
  options: SessionConfigOption[],
  { agentId, agentName, mode, model }: AcpSessionInputs,
): Promise<void> {
  const models = listSetting(options, 'model');
  if (models) {
    modelOptionsByAgent.set(
      agentId,
      models.values.map(({ value, name }) => ({ id: value, name })),
    );
  }
  let current = options;
  // The mode first: switching it may also switch the model.
  if (mode) {
    const refusal = `${agentName} has no ${mode} mode.`;
    current = await choose(connection, sessionId, current, {
      category: 'mode',
      value: mode,
      refusal,
    });
  }
  if (model) {
    const refusal = `${agentName} no longer offers ${model}. Pick another model.`;
    await choose(connection, sessionId, current, { category: 'model', value: model, refusal });
  }
}

/** Runs the ACP handshake and readies a session, closing the connection if that takes too long. */
export async function openSession(
  connection: ClientConnection,
  protocolVersion: number,
  inputs: AcpSessionInputs,
): Promise<OpenedSession> {
  const deadline = setTimeout(
    () => connection.close(new Error('The agent did not finish starting in time.')),
    START_DEADLINE_MS,
  );
  try {
    const initialized = await connection.agent.request('initialize', {
      protocolVersion,
      // Nothing is advertised: the agent acts with its own tools, so its launch must make it ask.
      clientCapabilities: {},
    });
    if (initialized.protocolVersion !== protocolVersion) {
      throw new Error(
        `The agent speaks ACP version ${initialized.protocolVersion}, not ${protocolVersion}.`,
      );
    }
    const capabilities = initialized.agentCapabilities;
    if (inputs.hasImages && !capabilities?.promptCapabilities?.image) {
      throw new Error(`${inputs.agentName} can't take images.`);
    }
    const canResume = Boolean(capabilities?.sessionCapabilities?.resume);
    const { sessionId, options, lostHistory } = await resumeOrCreate(connection, inputs, canResume);
    await applyChoices(connection, sessionId, options ?? [], inputs);
    return { sessionId, lostHistory };
  } finally {
    clearTimeout(deadline);
  }
}
