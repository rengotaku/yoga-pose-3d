import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { LM, type RawLandmark } from "./muscles";
import type { GoldenPose } from "./golden";
import {
  checkGoldenRom,
  romLimitFor,
  segmentDistance,
  buildBodyCapsules,
  detectSelfPenetrations,
  compareLandmarkPoses,
  SELF_PENETRATION,
  type SegmentCapsule,
} from "./poseValidity";

describe("romLimitFor", () => {
  it("mirrors Y/Z ranges for the right side and keeps X", () => {
    const left = romLimitFor("LeftUpLeg")!;
    const right = romLimitFor("RightUpLeg")!;
    expect(right.x).toEqual(left.x);
    expect(right.z).toEqual({ min: -left.z!.max, max: -left.z!.min });
  });

  it("returns null for bones without a limit (Hips)", () => {
    expect(romLimitFor("Hips")).toBeNull();
  });
});

describe("checkGoldenRom", () => {
  it("passes an in-range pose (実データの cross-seat 相当)", () => {
    const golden: GoldenPose = {
      pose: "t",
      rotations: {
        LeftUpLeg: [-25, -35, 75],
        RightUpLeg: [-25, 35, -75],
        LeftLeg: [135, 0, 0],
        LeftForeArm: [120, 0, 0],
      },
    };
    expect(checkGoldenRom(golden)).toEqual([]);
  });

  it("flags a reverse-bent knee and reports the excess", () => {
    const golden: GoldenPose = {
      pose: "t",
      rotations: { LeftLeg: [-40, 0, 0] },
    };
    const violations = checkGoldenRom(golden);
    expect(violations).toHaveLength(1);
    expect(violations[0].bone).toBe("LeftLeg");
    expect(violations[0].axis).toBe("x");
    expect(violations[0].excessDeg).toBeCloseTo(35, 5);
  });

  it("flags a mirrored abduction violation on the right hip", () => {
    // Left の Z 可動域 [-40, 90] → Right は [-90, 40]。Z=75 は左では合法・右では違反
    const golden: GoldenPose = {
      pose: "t",
      rotations: { RightUpLeg: [0, 0, 75] },
    };
    const violations = checkGoldenRom(golden);
    expect(violations).toHaveLength(1);
    expect(violations[0].axis).toBe("z");
  });
});

describe("segmentDistance", () => {
  it("returns distance between parallel segments", () => {
    const d = segmentDistance(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 2, 0),
      new THREE.Vector3(1, 2, 0)
    );
    expect(d).toBeCloseTo(2, 6);
  });

  it("clamps to segment endpoints", () => {
    const d = segmentDistance(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(3, 0, 0),
      new THREE.Vector3(4, 0, 0)
    );
    expect(d).toBeCloseTo(2, 6);
  });

  it("handles degenerate (point) segments", () => {
    const d = segmentDistance(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 3, 0),
      new THREE.Vector3(0, 3, 0)
    );
    expect(d).toBeCloseTo(3, 6);
  });
});

describe("detectSelfPenetrations", () => {
  const capsule = (
    name: string,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    radius: number
  ): SegmentCapsule => ({
    name,
    a: new THREE.Vector3(ax, ay, az),
    b: new THREE.Vector3(bx, by, bz),
    radius,
  });

  it("flags deep overlap between non-adjacent segments", () => {
    // 前腕が胴体軸を貫通（距離 0、半径和 0.17）→ 深さ 0.17 > 許容 0.03
    const caps = [
      capsule("torso", 0, 0, 0, 0, 0.5, 0, 0.13),
      capsule("foreArm:L", -0.2, 0.25, 0, 0.2, 0.25, 0, 0.04),
    ];
    const pens = detectSelfPenetrations(caps);
    expect(pens).toHaveLength(1);
    expect(pens[0].depthM).toBeCloseTo(0.17, 5);
  });

  it("allows light contact within the tolerance", () => {
    // 表面同士がちょうど接する（距離 = 半径和）→ 深さ 0
    const caps = [
      capsule("torso", 0, 0, 0, 0, 0.5, 0, 0.13),
      capsule("foreArm:L", -0.2, 0.25, 0.17, 0.2, 0.25, 0.17, 0.04),
    ];
    expect(detectSelfPenetrations(caps)).toHaveLength(0);
  });

  it("skips excluded adjacent pairs (torso × upperArm)", () => {
    const caps = [
      capsule("torso", 0, 0, 0, 0, 0.5, 0, 0.13),
      capsule("upperArm:L", 0, 0.4, 0, 0.1, 0.2, 0, 0.045),
    ];
    expect(detectSelfPenetrations(caps)).toHaveLength(0);
  });
});

describe("buildBodyCapsules", () => {
  it("builds capsules for resolvable segments and skips missing ones", () => {
    const root = new THREE.Group();
    const upLeg = new THREE.Bone();
    upLeg.name = "mixamorig:LeftUpLeg";
    const leg = new THREE.Bone();
    leg.name = "mixamorig:LeftLeg";
    leg.position.set(0, -0.45, 0);
    upLeg.add(leg);
    root.add(upLeg);
    root.updateMatrixWorld(true);

    const caps = buildBodyCapsules(root);
    expect(caps.map((c) => c.name)).toEqual(["thigh:L"]);
    expect(caps[0].radius).toBe(SELF_PENETRATION.radiusM.thigh);
    expect(caps[0].a.distanceTo(caps[0].b)).toBeCloseTo(0.45, 5);
  });
});

describe("compareLandmarkPoses", () => {
  // raw 座標（y 下向き正）。toVec で three 空間へ反転される
  const buildLm = (): RawLandmark[] => {
    const lm: RawLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
    lm[LM.LEFT_HIP] = { x: 0.1, y: 0, z: 0 };
    lm[LM.RIGHT_HIP] = { x: -0.1, y: 0, z: 0 };
    lm[LM.LEFT_SHOULDER] = { x: 0.15, y: -0.5, z: 0 };
    lm[LM.RIGHT_SHOULDER] = { x: -0.15, y: -0.5, z: 0 };
    lm[LM.LEFT_ELBOW] = { x: 0.3, y: -0.3, z: 0 };
    lm[LM.RIGHT_ELBOW] = { x: -0.3, y: -0.3, z: 0 };
    lm[LM.LEFT_WRIST] = { x: 0.4, y: -0.1, z: 0 };
    lm[LM.RIGHT_WRIST] = { x: -0.4, y: -0.1, z: 0 };
    lm[LM.LEFT_KNEE] = { x: 0.1, y: 0.45, z: 0 };
    lm[LM.RIGHT_KNEE] = { x: -0.1, y: 0.45, z: 0 };
    lm[LM.LEFT_ANKLE] = { x: 0.1, y: 0.9, z: 0 };
    lm[LM.RIGHT_ANKLE] = { x: -0.1, y: 0.9, z: 0 };
    return lm;
  };

  const rotateYRaw = (lm: RawLandmark[], deg: number): RawLandmark[] => {
    // raw 空間の y 軸まわり回転（three では -y が上だが y 軸回転は同型）
    const rad = (deg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return lm.map((p) => ({ ...p, x: p.x * c + p.z * s, z: -p.x * s + p.z * c }));
  };

  it("returns 0° for identical poses", () => {
    const r = compareLandmarkPoses(buildLm(), buildLm());
    expect(r.meanDeg).not.toBeNull();
    expect(r.meanDeg!).toBeLessThan(1e-6);
    expect(r.segments.length).toBe(9);
  });

  it("is invariant to a global yaw difference", () => {
    const r = compareLandmarkPoses(buildLm(), rotateYRaw(buildLm(), 60));
    expect(r.meanDeg).not.toBeNull();
    expect(r.meanDeg!).toBeLessThan(1);
  });

  it("detects a genuinely different segment", () => {
    const b = buildLm();
    b[LM.LEFT_WRIST] = { x: 0.3, y: -0.7, z: 0 }; // 前腕を上へ振る
    const r = compareLandmarkPoses(buildLm(), b);
    const fore = r.segments.find((s) => s.segment === "foreArm:L")!;
    expect(fore.angleDeg).toBeGreaterThan(45);
  });

  it("skips segments below the visibility gate", () => {
    const b = buildLm();
    b[LM.LEFT_ANKLE] = { x: 0.1, y: 0.9, z: 0, visibility: 0.2 };
    const r = compareLandmarkPoses(buildLm(), b);
    expect(r.skipped).toContain("calf:L");
  });
});
