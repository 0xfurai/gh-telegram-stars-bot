// Shared command-line helpers for the copy scripts (Node 24).
import { execFile } from "node:child_process";
import type { RunCommand } from "./io.ts";
import { utcDay } from "./to-d1.ts";
import type { CopyMode } from "./types.ts";

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Set ${name}`);
  }
  return value;
}

/** `--name=value` from the command line. */
export function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function copyMode(): CopyMode {
  const mode = option("mode");
  if (mode !== "full" && mode !== "shadow") {
    throw new Error("Pass --mode=full (the final copy at the switch) or --mode=shadow (the daily copy during the shadow run)");
  }
  return mode;
}

/** Which D1 database wrangler talks to: --local for a dry run, remote by default. */
export function d1Target(): "--remote" | "--local" {
  return flag("local") ? "--local" : "--remote";
}

export function today(): string {
  return utcDay(Date.now());
}

export const runCommand: RunCommand = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} ${args.slice(0, 3).join(" ")} failed: ${stderr || error.message}`));
      } else {
        resolve(stdout);
      }
    });
  });

/** Runs a script's main function; prints the error and sets exit code 1 on failure. */
export function runMain(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
