import { describe, it, expect } from "vitest";
import { STABILITY } from "./poseValidity";
import { stabilityBandFor } from "./stabilityViz";

describe("stabilityBandFor", () => {
  it("returns danger for a negative distance (outside the support polygon)", () => {
    expect(stabilityBandFor(-0.01)).toBe("danger");
  });

  it("returns warn just below marginM", () => {
    expect(stabilityBandFor(STABILITY.marginM - 0.001)).toBe("warn");
  });

  it("is NOT safe exactly at marginM (must match checkStability's strict `>` pass condition)", () => {
    // checkStability: pass = distanceToBoundaryM > STABILITY.marginM (strict >)
    // distance === marginM は checkStability では fail (pass: false) なので、
    // 可視化も safe (緑) にしてはいけない。
    expect(stabilityBandFor(STABILITY.marginM)).not.toBe("safe");
    expect(stabilityBandFor(STABILITY.marginM)).toBe("warn");
  });

  it("returns safe just above marginM", () => {
    expect(stabilityBandFor(STABILITY.marginM + 0.001)).toBe("safe");
  });
});
