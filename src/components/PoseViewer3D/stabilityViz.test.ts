import { describe, it, expect } from "vitest";
import { STABILITY } from "./poseValidity";
import { stabilityBandFor } from "./stabilityViz";

describe("stabilityBandFor", () => {
  it("returns safe when distance is positive (COM inside the support polygon)", () => {
    expect(stabilityBandFor(0.001)).toBe("safe");
  });

  it("returns warn at the boundary (distance === 0, neither clearly inside nor outside)", () => {
    expect(stabilityBandFor(0)).toBe("warn");
  });

  it("returns warn when distance is between marginM and 0 (outside boundary but gate still passes)", () => {
    // marginM = -0.04 のとき -0.02 は (marginM, 0] の warn zone 内
    const midpoint = STABILITY.marginM / 2;
    expect(stabilityBandFor(midpoint)).toBe("warn");
  });

  it("is NOT safe exactly at marginM (must match checkStability's strict `>` pass condition)", () => {
    // checkStability: pass = distanceToBoundaryM > STABILITY.marginM (strict >)
    // distance === marginM は checkStability では fail (pass: false) なので danger。
    expect(stabilityBandFor(STABILITY.marginM)).not.toBe("safe");
    expect(stabilityBandFor(STABILITY.marginM)).toBe("danger");
  });

  it("returns danger below marginM (gate also fails)", () => {
    expect(stabilityBandFor(STABILITY.marginM - 0.001)).toBe("danger");
  });

  it("degenerates to a safe/danger 2-band split when marginM is 0", () => {
    const original = STABILITY.marginM;
    // STABILITY は `as const` だが Object.freeze はされていないため、
    // marginM = 0 運用でも stabilityBandFor が破綻しないことをここで直接検証する。
    (STABILITY as unknown as { marginM: number }).marginM = 0;
    try {
      expect(stabilityBandFor(0.001)).toBe("safe");
      expect(stabilityBandFor(0)).toBe("danger");
      expect(stabilityBandFor(-0.001)).toBe("danger");
    } finally {
      (STABILITY as unknown as { marginM: number }).marginM = original;
    }
  });
});
