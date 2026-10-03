import { describe, expect, test } from "vitest";

import { safeNext, teamTokenFromNext } from "./navigation";

describe("safeNext", () => {
  test("keeps a path on this site", () => {
    expect(safeNext("/security")).toBe("/security");
    expect(safeNext("/invite/team?token=tin_abc")).toBe("/invite/team?token=tin_abc");
  });

  test("refuses anything that leaves the site", () => {
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext(null)).toBe("/");
  });
});

describe("teamTokenFromNext", () => {
  test("reads the token of a team invitation link", () => {
    expect(teamTokenFromNext("/invite/team?token=tin_abc")).toBe("tin_abc");
    expect(teamTokenFromNext("/teams")).toBeNull();
    expect(teamTokenFromNext("https://evil.example/invite/team?token=x")).toBeNull();
  });
});
