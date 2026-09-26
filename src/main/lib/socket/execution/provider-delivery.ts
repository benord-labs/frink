import log from 'electron-log';
// Aliased: the provider factory is named `project`, which the parameter below shadows.
import { awaitBounded, project as createProjectProvider, type ProviderType } from '../../provider';
import { detectUnbridgedProjectSkills } from '../../skills/unbridged-detect';
import { broadcastToRenderer } from '../client';

/** "Copy across?" prompt throttle — one toast per project+tool per app session. */
const unbridgedToasted = new Set<string>();

/** Spawn-time delivery of skills, commands and agent brains into the spawning tool's dirs.
 * Best-effort and bounded at 5s; a missing project row skips it. */
export async function deliverProviderConfig(
  project: { id: string } | null,
  projectPath: string,
  providerKind: ProviderType,
): Promise<void> {
  const PCH_PROVIDER_DELIVERY_ENABLED = true; // skills + commands + agent brains fire at spawn
  if (!PCH_PROVIDER_DELIVERY_ENABLED || !project) return;
  const providerBridge = createProjectProvider(project.id, projectPath, providerKind);
  const providerProbe = providerBridge.probe();
  if (!providerProbe.supported) {
    log.info(`[Socket Executor] provider unsupported: ${providerProbe.reason}`);
    return;
  }
  // Deliver skills + commands + agent brains so they "follow" the user into this
  // tool's dirs before the agent spawns. BEST-EFFORT: the outer try/catch + the
  // timeout below guarantee a handler fault or a slow FS can NEVER abort or hang the
  // spawn (this fn is async — an unhandled throw kills it). MCP stays on its existing
  // direct path (deliverMcp is a noop stub; MCP-through-spine is a deferred follow-up).
  try {
    const DELIVER_TIMEOUT_MS = 5_000;
    // Every handler is idempotent (skills additionally mutex-serialized), so a delivery
    // that overruns the deadline keeps completing in the background and lands by the
    // next spawn — the deadline abandons the AWAIT, not the work. We never claim
    // "ready" when it isn't.
    const delivered = Promise.all([
      providerBridge.deliver('skills'),
      providerBridge.deliver('commands'),
      providerBridge.deliver('agentBrain'),
    ]).catch((err) => {
      log.warn(`[Socket Executor] provider delivery error (non-fatal): ${String(err)}`);
    });
    if (await awaitBounded(delivered, DELIVER_TIMEOUT_MS)) {
      log.warn(
        `[Socket Executor] provider delivery >${DELIVER_TIMEOUT_MS}ms for ${providerKind}; spawning anyway (projection continues in background)`,
      );
    }
  } catch (err) {
    log.warn(`[Socket Executor] provider delivery failed (non-fatal): ${String(err)}`);
  }

  // DETECT-ONLY (never auto-copy a project skill — that is a silent repo write the Target forbids):
  // if this project has skills the spawning tool can't read, prompt the renderer to offer a copy.
  // Throttle to ONCE per project+tool per app session; add the key BEFORE the async scan so two
  // panes spawning in the same project never double-toast. Fire-and-forget: never delays the spawn.
  const unbridgedKey = `${project.id}:${providerKind}`;
  if (!unbridgedToasted.has(unbridgedKey)) {
    unbridgedToasted.add(unbridgedKey);
    detectUnbridgedProjectSkills(projectPath, providerKind)
      .then((skills) => {
        if (skills.length > 0) {
          // Least-data: the renderer resolves the path server-side from projectId in copyAcross,
          // so projectPath is not broadcast.
          broadcastToRenderer('provider:unbridged', {
            projectId: project.id,
            providerKind,
            skills,
          });
        }
      })
      .catch(() => {}); // best-effort; never affects the spawn
  }
}
