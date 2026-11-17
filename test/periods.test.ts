import { describe, expect, it } from "vitest";
import { isSnapshotDay, lastCompletePeriod, lastCompletePeriods, periodStart, sendTime } from "../src/periods";
import { offsetMs, parseTimeZone, zonedTime } from "../src/time-zone";

const at = (iso: string) => Date.parse(iso);

describe("periods", () => {
  it("starts weeks on Monday, months on the 1st and years on 1 January", () => {
    // 2026-11-07 is a Saturday.
    expect(periodStart("weekly", "2026-11-07")).toBe("2026-11-02");
    expect(periodStart("weekly", "2026-11-09")).toBe("2026-11-09");
    expect(periodStart("weekly", "2026-11-08")).toBe("2026-11-02");
    expect(periodStart("weekly", "2027-01-01")).toBe("2026-12-28");
    expect(periodStart("monthly", "2026-11-30")).toBe("2026-11-01");
    expect(periodStart("yearly", "2026-11-30")).toBe("2026-01-01");
  });

  it("finds the last complete period, across month and year ends", () => {
    expect(lastCompletePeriod("weekly", at("2026-11-16T00:00:00Z"))).toEqual({
      kind: "weekly",
      start: "2026-11-09",
      end: "2026-11-16",
    });
    expect(lastCompletePeriod("weekly", at("2026-11-15T23:59:59Z"))).toMatchObject({ start: "2026-11-02", end: "2026-11-09" });
    expect(lastCompletePeriods(at("2027-01-01T15:00:00Z"))).toEqual({
      weekly: { kind: "weekly", start: "2026-12-21", end: "2026-12-28" },
      monthly: { kind: "monthly", start: "2026-12-01", end: "2027-01-01" },
      yearly: { kind: "yearly", start: "2026-01-01", end: "2027-01-01" },
    });
  });

  it("takes snapshots on Mondays and on the 1st", () => {
    expect(isSnapshotDay("2026-11-09")).toBe(true);
    expect(isSnapshotDay("2026-12-01")).toBe(true);
    expect(isSnapshotDay("2027-01-01")).toBe(true);
    expect(isSnapshotDay("2026-11-07")).toBe(false);
    expect(isSnapshotDay("2026-11-10")).toBe(false);
  });
});

describe("send time", () => {
  it("is 15:00 UTC without a time zone", () => {
    expect(sendTime("2026-11-16", null)).toBe(at("2026-11-16T15:00:00Z"));
  });

  it("is 10:00 local time, daylight saving time included", () => {
    expect(sendTime("2026-11-16", "Europe/Berlin")).toBe(at("2026-11-16T09:00:00Z"));
    expect(sendTime("2026-07-01", "Europe/Berlin")).toBe(at("2026-07-01T08:00:00Z"));
    expect(sendTime("2026-11-16", "America/Los_Angeles")).toBe(at("2026-11-16T18:00:00Z"));
    expect(sendTime("2026-11-16", "UTC+05:30")).toBe(at("2026-11-16T04:30:00Z"));
  });

  it("never comes before the period ends", () => {
    // 10:00 on Monday in Kiritimati (UTC+14) is Sunday 20:00 UTC.
    expect(sendTime("2026-11-16", "Pacific/Kiritimati")).toBe(at("2026-11-16T00:00:00Z"));
  });

  it("falls back to the default hour for a time zone the runtime doesn't know", () => {
    expect(sendTime("2026-11-16", "Mars/Olympus")).toBe(at("2026-11-16T15:00:00Z"));
  });
});

describe("time zones", () => {
  it.each([
    ["Europe/Berlin", "Europe/Berlin"],
    ["europe/kyiv", "Europe/Kyiv"],
    ["UTC", "UTC"],
    ["+3", "UTC+03:00"],
    ["-5", "UTC-05:00"],
    ["+5:30", "UTC+05:30"],
    ["UTC+0545", "UTC+05:45"],
    ["gmt -3:30", "UTC-03:30"],
    ["-0", "UTC+00:00"],
    ["+14", "UTC+14:00"],
  ])("reads %s as %s", (input, stored) => {
    expect(parseTimeZone(input)).toEqual({ ok: true, value: stored });
  });

  it.each(["Mars/Olympus", "+15", "+3:75", "Berlin time", "", "../etc"])("refuses %j", (input) => {
    expect(parseTimeZone(input).ok).toBe(false);
  });

  it("knows each zone's offset at an instant", () => {
    expect(offsetMs("Europe/Berlin", at("2026-01-15T12:00:00Z"))).toBe(60 * 60 * 1000);
    expect(offsetMs("Europe/Berlin", at("2026-07-15T12:00:00Z"))).toBe(2 * 60 * 60 * 1000);
    expect(offsetMs("UTC-03:30", at("2026-07-15T12:00:00Z"))).toBe(-3.5 * 60 * 60 * 1000);
  });

  it("finds a local hour on the day the clocks change", () => {
    // Europe moves to summer time at 01:00 UTC on 29 March 2026.
    expect(zonedTime("2026-03-29", 10, "Europe/Berlin")).toBe(at("2026-03-29T08:00:00Z"));
    expect(zonedTime("2026-10-25", 10, "Europe/Berlin")).toBe(at("2026-10-25T09:00:00Z"));
  });
});
