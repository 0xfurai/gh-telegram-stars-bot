// Shared command-line helpers for the copy scripts (Node 24).
import { execFile } from "node:child_process";
import type { RunCommand } from "./io.ts";
import { optionValue, parseD1Target, targetErrorMessage, type D1Target } from "./target.ts";
import { gainsWindowStart, isUtcDay, utcDay } from "./to-d1.ts";
import type { CopyMode } from "./types.ts";

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Set ${name}`);
  }
  return value;
}

/** `--name=value` or `--name value` from the command line. */
export function option(name: string): string | undefined {
  return optionValue(process.argv.slice(2), name) ?? undefined;
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

/**
 * The D1 database from `--env` (required) and `--local`. A bad command line
 * ends the script here, the command-line edge, with the usage message.
 */
export function d1Target(): D1Target {
  const target = parseD1Target(process.argv.slice(2));
  if (!target.ok) {
    throw new Error(targetErrorMessage(target.error));
  }
  return target.value;
}

/** `--name=YYYY-MM-DD`, a real UTC day; `fallback` when absent (null: required). */
export function dayOption(name: string, fallback: string | null): string {
  const value = option(name) ?? fallback;
  if (value === null || !isUtcDay(value)) {
    throw new Error(`Pass --${name} as YYYY-MM-DD`);
  }
  return value;
}

/** `--today=YYYY-MM-DD` when given (the day the copy ran), otherwise today in UTC. */
export function today(): string {
  return dayOption("today", utcDay(Date.now()));
}

/** Star events since the start of the gains window, as a PostgREST timestamp. */
export function starEventsSince(day: string): string {
  return `${gainsWindowStart(day)}T00:00:00Z`;
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
