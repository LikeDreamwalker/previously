import { describe, it, expect } from "vitest";
import { tolerantBounded01, tolerantNumberArray } from "@/lib/chat/tolerant-schemas";

describe("tolerantBounded01", () => {
  it("passes through valid values unchanged", () => {
    expect(tolerantBounded01.parse(0.5)).toBe(0.5);
    expect(tolerantBounded01.parse(0)).toBe(0);
    expect(tolerantBounded01.parse(1)).toBe(1);
  });

  it("coerces numeric strings", () => {
    expect(tolerantBounded01.parse("0.8")).toBe(0.8);
  });

  it("clamps out-of-range values into [0, 1]", () => {
    expect(tolerantBounded01.parse(1.5)).toBe(1);
    expect(tolerantBounded01.parse(-0.2)).toBe(0);
    expect(tolerantBounded01.parse("2.0")).toBe(1);
  });

  it("degrades NaN, null, and unparseable to 0", () => {
    expect(tolerantBounded01.parse(NaN)).toBe(0);
    expect(tolerantBounded01.parse(null)).toBe(0);
    expect(tolerantBounded01.parse("abc")).toBe(0);
    expect(tolerantBounded01.parse(undefined)).toBe(0);
  });
});

describe("tolerantNumberArray", () => {
  it("passes through a valid numeric list", () => {
    expect(tolerantNumberArray.parse([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("coerces numeric strings and drops non-numeric members", () => {
    expect(tolerantNumberArray.parse([1, "2", "a3fk2w"])).toEqual([1, 2]);
    expect(tolerantNumberArray.parse(["x", 1.5])).toEqual([1.5]);
  });

  it("drops NaN members", () => {
    expect(tolerantNumberArray.parse([1, NaN, 3])).toEqual([1, 3]);
  });

  it("degrades a non-array to []", () => {
    expect(tolerantNumberArray.parse("notarray")).toEqual([]);
    expect(tolerantNumberArray.parse(null)).toEqual([]);
    expect(tolerantNumberArray.parse(42)).toEqual([]);
  });
});
