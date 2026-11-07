// Which D1 database a copy script works on, and the guard that keeps a
// staging rehearsal away from production Supabase. Pure: no I/O.
import type { Environment } from "../../src/environment.ts";
import { assertNever, err, ok, type Result } from "../../src/result.ts";

/** Which D1 database: the wrangler environment, remote or local (a dry run). */
export interface D1Target {
  environment: Environment;
  location: "remote" | "local";
}

export type TargetError =
  | { kind: "missing-env" }
  | { kind: "unknown-env"; value: string };

// A Record, so adding an environment to src/config.ts fails to compile here
// until the scripts know it too.
const KNOWN_ENVIRONMENTS: Record<Environment, true> = { production: true, staging: true };

function isEnvironment(value: string): value is Environment {
  return Object.hasOwn(KNOWN_ENVIRONMENTS, value);
}

/** `--name=value` or `--name value` from the arguments; null when absent. */
export function optionValue(args: readonly string[], name: string): string | null {
  const flag = `--${name}`;
  for (const [index, arg] of args.entries()) {
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
    if (arg === flag) {
      return args[index + 1] ?? "";
    }
  }
  return null;
}

/**
 * The D1 target from the command line. `--env` is required, with no default,
 * so a script can't read production while meaning staging, or the reverse.
 */
export function parseD1Target(args: readonly string[]): Result<D1Target, TargetError> {
  const environment = optionValue(args, "env");
  if (environment === null) {
    return err({ kind: "missing-env" });
  }
  if (!isEnvironment(environment)) {
    return err({ kind: "unknown-env", value: environment });
  }
  return ok({ environment, location: args.includes("--local") ? "local" : "remote" });
}

export function targetErrorMessage(error: TargetError): string {
  switch (error.kind) {
    case "missing-env":
      return "Pass --env=production or --env=staging: the D1 database to use";
    case "unknown-env":
      return `Unknown --env "${error.value}": pass --env=production or --env=staging`;
    default:
      return assertNever(error);
  }
}

/** wrangler's flags for a target. Production is wrangler.jsonc's top level, so it has no --env. */
export function wranglerTargetArgs(target: D1Target): string[] {
  const location = `--${target.location}`;
  switch (target.environment) {
    case "production":
      return [location];
    case "staging":
      return [location, "--env", "staging"];
    default:
      return assertNever(target.environment);
  }
}

/** The copy scripts' own flags for a target, for the next-step commands they print. */
export function scriptTargetArgs(target: D1Target): string[] {
  return [`--env=${target.environment}`, ...(target.location === "local" ? ["--local"] : [])];
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Copy-back writes into Supabase and deletes subscriptions D1 doesn't have.
 * From staging, that must go to a local scratch Supabase (`supabase start`),
 * never to a hosted project: with production's URL still set, a rehearsal
 * would overwrite production's chats and delete its subscriptions.
 */
export function checkCopyBackTarget(target: D1Target, supabaseUrl: string): Result<void, "staging-into-hosted-supabase"> {
  switch (target.environment) {
    case "production":
      return ok(undefined);
    case "staging":
      return LOCAL_HOSTS.has(new URL(supabaseUrl).hostname) ? ok(undefined) : err("staging-into-hosted-supabase");
    default:
      return assertNever(target.environment);
  }
}
