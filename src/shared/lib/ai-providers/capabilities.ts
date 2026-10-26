/** How one kind of config reaches a provider: `inject` in memory at launch, `copy` or `file` on
 * disk, `enforce` or `advisory` at its permission gate, or `none`. */
export type CapabilityMode = 'inject' | 'copy' | 'file' | 'advisory' | 'enforce' | 'none';

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
};

export type CapabilityCategory = keyof Delivery;

/** What Frink gives one provider. */
export type CapabilityRow = { delivery: Delivery };

export const NOTHING_DELIVERED: Delivery = {
  mcp: 'none',
  skills: 'none',
  commands: 'none',
  agentBrain: 'none',
  allowlist: 'none',
  hooks: 'none',
  plugins: 'none',
  instructions: 'none',
};
