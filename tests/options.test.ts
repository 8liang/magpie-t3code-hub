import { describe, expect, test } from "bun:test";
import { strictOptionNumber } from "../src/hub/options";

describe("strictOptionNumber", () => {
  test("reports invalid values without JSON.stringify throwing", () => {
    expect(() => strictOptionNumber(10n, "port")).toThrow(/Invalid port 10n/);
    expect(() => strictOptionNumber(Number.NaN, "port")).toThrow(/Invalid port NaN/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => strictOptionNumber(cyclic, "port")).toThrow(/Invalid port/);
  });

  test("treats absent and blank values as unset", () => {
    expect(strictOptionNumber(undefined, "x")).toBeUndefined();
    expect(strictOptionNumber(null, "x")).toBeUndefined();
    expect(strictOptionNumber("   ", "x")).toBeUndefined();
  });

  test("accepts numeric strings", () => {
    expect(strictOptionNumber("4319", "port")).toBe(4319);
  });
});
