import { describe, expect, test } from "vitest";

import { formatBytes, formatDateTime, formatRelative, formatUptime, initials, personLabel } from "./format";

describe("formatBytes", () => {
  test("scales through the units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024)).toBe("10 KB");
    expect(formatBytes(256 * 1024 * 1024)).toBe("256 MB");
  });

  test("does not produce a decimal for whole bytes", () => {
    expect(formatBytes(7)).toBe("7 B");
  });

  test("survives values that should never reach it", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("formatRelative", () => {
  const now = Date.now();

  test("describes recent moments relatively", () => {
    expect(formatRelative(new Date(now - 90_000).toISOString(), "en")).toMatch(/minute/);
    expect(formatRelative(new Date(now - 3 * 3600_000).toISOString(), "en")).toMatch(/hour/);
  });

  test("switches to an absolute date past a week", () => {
    // Relative time stops being useful once it is "3 weeks ago"; a date is
    // what someone actually wants at that distance.
    const old = new Date(now - 40 * 86_400_000).toISOString();
    expect(formatRelative(old, "en")).not.toMatch(/ago/);
  });

  test("returns an empty string rather than 'Invalid Date'", () => {
    expect(formatRelative(null, "en")).toBe("");
    expect(formatRelative(undefined, "en")).toBe("");
    expect(formatRelative("not-a-date", "en")).toBe("");
    expect(formatDateTime("not-a-date", "en")).toBe("");
  });
});

describe("formatUptime", () => {
  test("drops to the two largest meaningful units", () => {
    expect(formatUptime(45)).toBe("0m");
    expect(formatUptime(3 * 60)).toBe("3m");
    expect(formatUptime(2 * 3600 + 30 * 60)).toBe("2h 30m");
    expect(formatUptime(5 * 86_400 + 3 * 3600)).toBe("5d 3h");
  });
});

describe("person labels", () => {
  test("prefers a display name and falls back to the address", () => {
    expect(personLabel({ displayName: "Alex Admin", email: "a@example.com" })).toBe("Alex Admin");
    expect(personLabel({ displayName: null, email: "a@example.com" })).toBe("a@example.com");
    expect(personLabel({ displayName: "   ", email: "a@example.com" })).toBe("a@example.com");
  });

  test("derives initials from either", () => {
    expect(initials({ displayName: "Alex Admin", email: "a@example.com" })).toBe("AA");
    expect(initials({ displayName: null, email: "sam.smith@example.com" })).toBe("SS");
    expect(initials({ displayName: null, email: "ops@example.com" })).toBe("OE");
  });
});
