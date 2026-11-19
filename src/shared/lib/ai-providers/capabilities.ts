/** `none`: never reaches the model in a Frink chat. `inject`: reaches it with no Frink file write.
 * `copy`, `file`: Frink writes it, as files or settings. `enforce`: held at the permission gate. */
export type CapabilityMode = 'inject' | 'copy' | 'file' | 'enforce' | 'none';

/** How each kind of the user's config reaches one provider. */
export type Delivery = {
  mcp: CapabilityMode;
  skills: CapabilityMode;
  commands: CapabilityMode;
  /** A sub-agent's name, description, prompt and model. */
  agentBrain: CapabilityMode;
  /** A sub-agent's tool limit. */
  allowlist: CapabilityMode;
  hooks: CapabilityMode;
  plugins: CapabilityMode;
  /** The user's instructions files. Report-only: no handler delivers them. */
  instructions: CapabilityMode;
  /** The project memory the agent keeps for itself. Report-only, like instructions. */
  memory: CapabilityMode;
};

export type CapabilityCategory = keyof Delivery;

/** Frink features a provider may run. Each flag is set only by the grid rows that verify it. */
export const FEATURES = ['debug'] as const;
export type Feature = (typeof FEATURES)[number];

/** What Frink gives one provider, and which of its features run there. */
export type CapabilityRow = { delivery: Delivery; features: Record<Feature, boolean> };

export const NOTHING_DELIVERED: Delivery = {
  mcp: 'none',
  skills: 'none',
  commands: 'none',
  agentBrain: 'none',
  allowlist: 'none',
  hooks: 'none',
  plugins: 'none',
  instructions: 'none',
  memory: 'none',
};
