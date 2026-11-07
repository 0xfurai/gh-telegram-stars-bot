import { describe, expect, it } from "vitest";
import {
  checkCopyBackTarget,
  optionValue,
  parseD1Target,
  scriptTargetArgs,
  targetErrorMessage,
  wranglerTargetArgs,
} from "../scripts/migration/target";

describe("parseD1Target", () => {
  it("requires --env, with no default", () => {
    expect(parseD1Target(["--mode=full"])).toEqual({ ok: false, error: { kind: "missing-env" } });
  });

  it("rejects an unknown environment, naming it", () => {
    const result = parseD1Target(["--env=prod"]);

    expect(result).toEqual({ ok: false, error: { kind: "unknown-env", value: "prod" } });
    expect(!result.ok && targetErrorMessage(result.error)).toBe('Unknown --env "prod": pass --env=production or --env=staging');
  });

  it("accepts --env=value and wrangler's --env value", () => {
    expect(parseD1Target(["--env=staging"])).toEqual({ ok: true, value: { environment: "staging", location: "remote" } });
    expect(parseD1Target(["--env", "production", "--local"])).toEqual({
      ok: true,
      value: { environment: "production", location: "local" },
    });
  });

  it("doesn't take a flag for the value of a bare --env", () => {
    expect(parseD1Target(["--env", "--local"])).toEqual({ ok: false, error: { kind: "unknown-env", value: "--local" } });
    expect(parseD1Target(["--env"])).toEqual({ ok: false, error: { kind: "unknown-env", value: "" } });
  });

  it("ignores options that only start with the name", () => {
    expect(optionValue(["--envelope=x"], "env")).toBeNull();
  });
});

describe("target flags", () => {
  it.each([
    [{ environment: "production", location: "remote" }, ["--remote"], ["--env=production"]],
    [{ environment: "production", location: "local" }, ["--local"], ["--env=production", "--local"]],
    [{ environment: "staging", location: "remote" }, ["--remote", "--env", "staging"], ["--env=staging"]],
    [{ environment: "staging", location: "local" }, ["--local", "--env", "staging"], ["--env=staging", "--local"]],
  ] as const)("%o: wrangler %o, scripts %o", (target, wrangler, script) => {
    expect(wranglerTargetArgs(target)).toEqual(wrangler);
    expect(scriptTargetArgs(target)).toEqual(script);
  });
});

describe("checkCopyBackTarget", () => {
  const staging = { environment: "staging", location: "remote" } as const;
  const production = { environment: "production", location: "remote" } as const;

  it("refuses to copy staging into a hosted Supabase", () => {
    expect(checkCopyBackTarget(staging, "https://abcdefgh.supabase.co")).toEqual({
      ok: false,
      error: "staging-into-hosted-supabase",
    });
  });

  it.each(["http://127.0.0.1:54321", "http://localhost:54321", "http://[::1]:54321"])(
    "lets staging into a local scratch Supabase (%s)",
    (url) => {
      expect(checkCopyBackTarget(staging, url).ok).toBe(true);
    },
  );

  it("lets production into any Supabase: that's the real rollback", () => {
    expect(checkCopyBackTarget(production, "https://abcdefgh.supabase.co").ok).toBe(true);
  });
});
