import { describe, expect, it } from "vitest";
import { coversWorstCase, maxRequestCost } from "@/lib/billing/limits";
import { parseCompletion, parseImages } from "@/lib/publicApi";

const FREE = { overage: false }, SCALE = { overage: true };

describe("Free never bills overage: worst-case cost guard", () => {
  it("worst case = input tokens + max_tokens output + images", () => {
    // 100k in (€0.20) + max 50k out (€0.40) even if only 1k out was reported
    expect(maxRequestCost({ requestId: "r", inputTokens: 100_000, outputTokens: 1_000, maxOutputTokens: 50_000 }, 0)).toBeCloseTo(0.6, 10);
    expect(maxRequestCost({ requestId: "r", images: 3 }, 0)).toBeCloseTo(0.12, 10);
    expect(maxRequestCost({ requestId: "r", images: 10 }, 0.1)).toBeCloseTo(0.36, 10); // plan discount applies
  });
  it("accepts when the balance covers the worst case exactly, rejects a cent short", () => {
    const r = { requestId: "r", images: 25 }; // €1.00
    expect(coversWorstCase(FREE, 1, r, 0)).toBe(true);
    expect(coversWorstCase(FREE, 0.99, r, 0)).toBe(false);
    expect(coversWorstCase(FREE, 0, { requestId: "r", inputTokens: 1 }, 0)).toBe(false);
  });
  it("the live Free overshoot case is now rejected (€0.90 left, request worth €3.40)", () => {
    expect(coversWorstCase(FREE, 0.9, { requestId: "live-free-2", inputTokens: 500_000, outputTokens: 300_000 }, 0)).toBe(false);
  });
  it("plans with overage, or auto-recharge on, are not limited by the balance", () => {
    expect(coversWorstCase(SCALE, 0, { requestId: "r", images: 1000 }, 0.2)).toBe(true);
    expect(coversWorstCase({ overage: false, autoRecharge: true }, 0.5, { requestId: "r", images: 100 }, 0.1)).toBe(true);
  });
  it("the public API reserves max_tokens for completions and n for images", () => {
    const c = parseCompletion({ prompt: "x".repeat(4000), max_tokens: 4096 });
    if (typeof c === "string") throw new Error(c);
    expect(c.usage.maxOutputTokens).toBe(4096);
    expect(maxRequestCost(c.usage, 0)).toBeCloseTo(1000 * 2e-6 + 4096 * 8e-6, 10);
    const i = parseImages({ prompt: "cat", n: 4 });
    if (typeof i === "string") throw new Error(i);
    expect(maxRequestCost(i.usage, 0)).toBeCloseTo(0.16, 10);
  });
});
