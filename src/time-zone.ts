// Chat time zones (/timezone), for the hour summaries go out.
//
// Telegram doesn't tell bots a user's time zone, so a chat sets one if it
// wants to. Stored as an IANA name ("Europe/Berlin", canonical case) or as a
// fixed offset ("UTC+05:30"). IANA names follow daylight saving time; fixed
// offsets don't.
import { err, ok, type Result } from "./result";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** "+3", "-5", "+5:30", "UTC+3", "GMT-03:30". */
const OFFSET_INPUT = /^(?:UTC|GMT)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i;
/** How a fixed offset is stored. */
const STORED_OFFSET = /^UTC([+-])(\d{2}):(\d{2})$/;
/** Real offsets run from UTC-12:00 to UTC+14:00. */
const MAX_OFFSET_MINUTES = 14 * 60;

function formatOffset(sign: string, hours: number, minutes: number): string {
  return `UTC${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function parseOffset(match: RegExpMatchArray): Result<string, "invalid-time-zone"> {
  const [, sign = "+", hoursText = "", minutesText = "0"] = match;
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const total = hours * 60 + minutes;
  if (minutes >= 60 || total > MAX_OFFSET_MINUTES) {
    return err("invalid-time-zone");
  }
  return ok(formatOffset(total === 0 ? "+" : sign, hours, minutes));
}

/**
 * The name as the user means it, in its usual case. ICU resolves some names
 * to an older alias (Europe/Kyiv to Europe/Kiev), so the resolved name is
 * only used when it's the same name.
 */
function displayName(input: string, resolved: string): string {
  const lower = input.toLowerCase();
  if (resolved.toLowerCase() === lower) {
    return resolved;
  }
  return Intl.supportedValuesOf("timeZone").find((name) => name.toLowerCase() === lower) ?? titleCase(input);
}

/** "europe/kyiv" -> "Europe/Kyiv"; input with capitals is kept as typed. */
function titleCase(input: string): string {
  if (input !== input.toLowerCase()) {
    return input;
  }
  return input.replace(/(^|[/_])([a-z])/g, (_, boundary: string, letter: string) => boundary + letter.toUpperCase());
}

function parseIanaName(input: string): Result<string, "invalid-time-zone"> {
  try {
    return ok(displayName(input, new Intl.DateTimeFormat("en-US", { timeZone: input }).resolvedOptions().timeZone));
  } catch {
    return err("invalid-time-zone");
  }
}

/** A time zone from user input, as it's stored. */
export function parseTimeZone(input: string): Result<string, "invalid-time-zone"> {
  const text = input.trim();
  const offset = text.match(OFFSET_INPUT);
  if (offset) {
    return parseOffset(offset);
  }
  return /^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(text) ? parseIanaName(text) : err("invalid-time-zone");
}

function fixedOffsetMs(timeZone: string): number | null {
  const match = timeZone.match(STORED_OFFSET);
  if (!match) {
    return null;
  }
  const [, sign, hours = "0", minutes = "0"] = match;
  const ms = Number(hours) * HOUR_MS + Number(minutes) * MINUTE_MS;
  return sign === "-" ? -ms : ms;
}

function ianaOffsetMs(timeZone: string, instant: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  return local - (instant - (instant % 1000));
}

/** How far `timeZone` is ahead of UTC at `instant`, in milliseconds. */
export function offsetMs(timeZone: string, instant: number): number {
  return fixedOffsetMs(timeZone) ?? ianaOffsetMs(timeZone, instant);
}

/**
 * The instant when it's `hour`:00 on `day` (YYYY-MM-DD) in `timeZone`. Two
 * passes, so an offset that changes (daylight saving time) near that hour is
 * still right.
 */
export function zonedTime(day: string, hour: number, timeZone: string): number {
  const asUtc = Date.parse(`${day}T00:00:00Z`) + hour * HOUR_MS;
  const first = asUtc - offsetMs(timeZone, asUtc);
  return asUtc - offsetMs(timeZone, first);
}
