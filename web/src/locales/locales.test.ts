import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { en } from "./en";

/**
 * Guards the i18n layer against the two ways it quietly breaks: a translation
 * file drifting out of sync with the source, and a component reaching for a
 * key nobody defined.
 */
describe("locales", () => {
  test("every key has a non-empty English string", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value, `${key} is empty`).toBeTruthy();
      expect(typeof value).toBe("string");
    }
  });

  test("keys are namespaced so they stay findable", () => {
    for (const key of Object.keys(en)) {
      expect(key, `${key} has no namespace`).toMatch(/^[a-z]+\.[A-Za-z]+$/);
    }
  });

  test("placeholders are well formed", () => {
    for (const [key, value] of Object.entries(en)) {
      // A stray brace means a placeholder that will render literally.
      const opens = (value.match(/\{/g) ?? []).length;
      const closes = (value.match(/\}/g) ?? []).length;
      expect(opens, `${key} has unbalanced braces`).toBe(closes);
      for (const match of value.matchAll(/\{(\w*)\}/g)) {
        expect(match[1], `${key} has an empty placeholder`).toBeTruthy();
      }
    }
  });

  test("every key a component uses exists", () => {
    const source = path.resolve(import.meta.dirname, "..");
    const used = new Set<string>();
    for (const file of walk(source)) {
      if (!/\.tsx?$/.test(file) || file.includes(".test.")) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/\bt\(\s*"([a-z]+\.[A-Za-z]+)"/g)) {
        used.add(match[1]);
      }
    }
    // Without this the test would pass on an empty scan, which is exactly the
    // state a broken regex would leave it in.
    expect(used.size).toBeGreaterThan(50);

    // Nothing renders a raw key to a person because a component asked for a
    // string that was never written.
    const missing = [...used].filter((key) => !(key in en));
    expect(missing, `missing translations: ${missing.join(", ")}`).toEqual([]);
  });
});

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}
