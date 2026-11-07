// The deploy environments (wrangler.jsonc's top level and env.staging). No
// imports, so the Node copy scripts can use it too.
export const ENVIRONMENTS = ["production", "staging"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];
