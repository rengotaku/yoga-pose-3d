import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { LM, type RawLandmark } from "./muscles";
import {
  resolveBoneName,
  computeRotation,
  computeDirection,
  computeMidpoint,
  computeSpineDirection,
  computeNeckDirection,
  computeHipsRotation,
  LIMB_BONE_MAPPINGS,
  distributeSpineRotation,
  computeBackbendAmount,
  computeBackbendArchRotations,
  BACKBEND_ARCH,
} from "./retarget";

const buildMockLandmarks = (): RawLandmark[] => {
  const lm: RawLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
  lm[LM.NOSE] = { x: 0, y: -0.75, z: 0 };
  lm[LM.LEFT_SHOULDER] = { x: 0.18, y: -0.5, z: 0 };
  lm[LM.RIGHT_SHOULDER] = { x: -0.18, y: -0.5, z: 0 };
  lm[LM.LEFT_ELBOW] = { x: 0.2, y: -0.25, z: 0 };
  lm[LM.RIGHT_ELBOW] = { x: -0.2, y: -0.25, z: 0 };
  lm[LM.LEFT_WRIST] = { x: 0.22, y: 0.0, z: 0 };
  lm[LM.RIGHT_WRIST] = { x: -0.22, y: 0.0, z: 0 };
  lm[LM.LEFT_HIP] = { x: 0.1, y: 0.0, z: 0 };
  lm[LM.RIGHT_HIP] = { x: -0.1, y: 0.0, z: 0 };
  lm[LM.LEFT_KNEE] = { x: 0.1, y: 0.45, z: 0 };
  lm[LM.RIGHT_KNEE] = { x: -0.1, y: 0.45, z: 0 };
  lm[LM.LEFT_ANKLE] = { x: 0.1, y: 0.9, z: 0 };
  lm[LM.RIGHT_ANKLE] = { x: -0.1, y: 0.9, z: 0 };
  lm[LM.LEFT_FOOT_INDEX] = { x: 0.1, y: 0.95, z: -0.15 };
  lm[LM.RIGHT_FOOT_INDEX] = { x: -0.1, y: 0.95, z: -0.15 };
  return lm;
};

describe("resolveBoneName", () => {
  it("resolves bone name by suffix ignoring prefix and colon", () => {
    const actualNames = [
      "mixamorigHips",
      "mixamorigLeftUpLeg",
      "RightArm",
      "HeadTop_End",
    ];

    expect(resolveBoneName("mixamorig:Hips", actualNames)).toBe("mixamorigHips");
    expect(resolveBoneName("mixamorig:LeftUpLeg", actualNames)).toBe(
      "mixamorigLeftUpLeg"
    );
    expect(resolveBoneName("mixamorig:HeadTop_End", actualNames)).toBe("HeadTop_End");
  });

  it("resolves bone name by exact match from aliases if suffix not found", () => {
    const actualNames = ["pelvis", "spine_01", "upperarm_l", "head_leaf"];

    expect(resolveBoneName("mixamorig:Hips", actualNames)).toBe("pelvis");
    expect(resolveBoneName("mixamorig:Spine", actualNames)).toBe("spine_01");
    expect(resolveBoneName("mixamorig:LeftArm", actualNames)).toBe("upperarm_l");
    // head_leaf should not match Head
    expect(resolveBoneName("mixamorig:Head", actualNames)).toBeUndefined();
  });

  it("returns undefined if suffix not found and no alias matches", () => {
    const actualNames = ["mixamorigHips", "mixamorigLeftUpLeg"];
    expect(resolveBoneName("mixamorig:Spine", actualNames)).toBeUndefined();
  });
});

describe("computeRotation", () => {
  it("computes rotation from initialDir to targetDir", () => {
    const initialDir = new THREE.Vector3(0, 1, 0);
    const targetDir = new THREE.Vector3(1, 0, 0);
    const q = computeRotation(initialDir, targetDir);

    const rotated = initialDir.clone().applyQuaternion(q);
    expect(rotated.x).toBeCloseTo(1);
    expect(rotated.y).toBeCloseTo(0);
    expect(rotated.z).toBeCloseTo(0);
  });
});

describe("computeDirection", () => {
  it("computes normalized vector between two landmarks", () => {
    const p1 = { x: 0, y: 0, z: 0 };
    const p2 = { x: 0, y: 1, z: 0 }; // y=1 means downward in mediapipe, so y=-1 in three

    const dir = computeDirection(p1, p2);
    expect(dir).not.toBeNull();
    expect(dir!.x).toBeCloseTo(0);
    expect(dir!.y).toBeCloseTo(-1);
    expect(dir!.z).toBeCloseTo(0);
  });

  it("returns null if points are undefined or identical", () => {
    expect(computeDirection(undefined, { x: 0, y: 0, z: 0 })).toBeNull();
    expect(computeDirection({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBeNull();
  });
});

describe("computeMidpoint", () => {
  it("computes midpoint in three.js coordinates", () => {
    const p1 = { x: -1, y: 2, z: -3 };
    const p2 = { x: 1, y: 4, z: 5 };
    const mid = computeMidpoint(p1, p2);
    expect(mid).not.toBeNull();
    // toVec turns y, z into negative
    expect(mid!.x).toBeCloseTo(0);
    expect(mid!.y).toBeCloseTo(-3);
    expect(mid!.z).toBeCloseTo(-1);
  });
});

describe("computeSpineDirection", () => {
  it("computes direction from hips midpoint to shoulders midpoint", () => {
    const landmarks = buildMockLandmarks();
    const dir = computeSpineDirection(landmarks);
    expect(dir).not.toBeNull();
    // In mock:
    // hipMid = (0, 0, 0)
    // shMid = (0, -0.5, 0) in mediapipe -> (0, 0.5, 0) in three
    // dir should be (0, 1, 0)
    expect(dir!.x).toBeCloseTo(0);
    expect(dir!.y).toBeGreaterThan(0);
    expect(dir!.z).toBeCloseTo(0);
  });
});

describe("computeNeckDirection", () => {
  it("computes direction from shoulder midpoint to nose", () => {
    const landmarks = buildMockLandmarks();
    const dir = computeNeckDirection(landmarks);
    expect(dir).not.toBeNull();
    // shMid = (0, 0.5, 0) in three
    // nose = (0, -0.75, 0) in mediapipe -> (0, 0.75, 0) in three
    // dir should be (0, 1, 0)
    expect(dir!.x).toBeCloseTo(0);
    expect(dir!.y).toBeGreaterThan(0);
    expect(dir!.z).toBeCloseTo(0);
  });
});

describe("computeHipsRotation", () => {
  it("computes a valid quaternion base on hips and spine", () => {
    const landmarks = buildMockLandmarks();
    const q = computeHipsRotation(landmarks);
    expect(q).not.toBeNull();
    expect(q).toBeInstanceOf(THREE.Quaternion);
    // test length is ~1
    expect(q!.length()).toBeCloseTo(1);
  });
});

describe("LIMB_BONE_MAPPINGS", () => {
  it("contains expected entries mapping to MediaPipe landmarks", () => {
    expect(LIMB_BONE_MAPPINGS["mixamorig:LeftUpLeg"].parentLm).toBe(LM.LEFT_HIP);
    expect(LIMB_BONE_MAPPINGS["mixamorig:RightArm"].childLm).toBe(LM.RIGHT_ELBOW);
  });
});

/**
 * 後屈（wheel 様）のモック: 骨盤が頂点で belly-forward 軸が world 上向き。
 * MediaPipe 座標（y 下向き正）。hips: z 軸沿いに左右、shoulders: 骨盤より
 * 下（y 正）かつ +x 側 → three 座標で belly 軸 ≈ (0.83, 0.56, 0)。
 */
const buildBackbendLandmarks = (): RawLandmark[] => {
  const lm: RawLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
  lm[LM.LEFT_HIP] = { x: 0, y: 0, z: -0.06 };
  lm[LM.RIGHT_HIP] = { x: 0, y: 0, z: 0.06 };
  lm[LM.LEFT_SHOULDER] = { x: 0.25, y: 0.37, z: -0.05 };
  lm[LM.RIGHT_SHOULDER] = { x: 0.25, y: 0.37, z: 0.05 };
  return lm;
};

describe("computeBackbendAmount", () => {
  it("returns 0 for an upright pose (belly axis is horizontal)", () => {
    expect(computeBackbendAmount(buildMockLandmarks())).toBe(0);
  });

  it("returns positive amount for a backbend pose (belly axis points up)", () => {
    const amount = computeBackbendAmount(buildBackbendLandmarks());
    expect(amount).toBeGreaterThan(0);
    expect(amount).toBeLessThanOrEqual(1);
  });

  it("returns 0 when belly axis points down (downdog-like fold)", () => {
    // 前屈: shoulders が骨盤より下かつ -x 側 → belly 軸は下向きになる
    const lm = buildBackbendLandmarks();
    lm[LM.LEFT_SHOULDER] = { x: -0.25, y: 0.37, z: -0.05 };
    lm[LM.RIGHT_SHOULDER] = { x: -0.25, y: 0.37, z: 0.05 };
    expect(computeBackbendAmount(lm)).toBe(0);
  });
});

describe("computeBackbendArchRotations", () => {
  it("returns null for an upright pose", () => {
    expect(computeBackbendArchRotations(buildMockLandmarks())).toBeNull();
  });

  it("returns bow deltas [+A, -A, -A] preserving the end position", () => {
    const landmarks = buildBackbendLandmarks();
    const qs = computeBackbendArchRotations(landmarks);
    expect(qs).not.toBeNull();
    const [q0, q1, q2] = qs!;

    // 角度 A = amount * maxArchRad
    const amount = computeBackbendAmount(landmarks);
    const expectedA = amount * BACKBEND_ARCH.maxArchRad;
    expect(q0.angleTo(new THREE.Quaternion())).toBeCloseTo(expectedA, 5);

    // q1 は q0 の逆回転、q2 は q1 と同一（弓: 傾き [+A, 0, -A]）
    const composed = q0.clone().multiply(q1);
    expect(composed.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 5);
    expect(q1.angleTo(q2)).toBeCloseTo(0, 5);
  });

  it("bends the base segment toward the belly side", () => {
    const landmarks = buildBackbendLandmarks();
    const [q0] = computeBackbendArchRotations(landmarks)!;
    const hipsQ = computeHipsRotation(landmarks)!;
    const belly = new THREE.Vector3(0, 0, 1).applyQuaternion(hipsQ);
    const spineUp = new THREE.Vector3(0, 1, 0).applyQuaternion(hipsQ);
    const bent = spineUp.clone().applyQuaternion(q0);
    // 曲げ後の基部セグメントは belly 軸との内積が増える（腹側へ膨らむ）
    expect(bent.dot(belly)).toBeGreaterThan(spineUp.dot(belly) + 0.1);
  });
});

describe("distributeSpineRotation", () => {
  it("distributes rotation such that the composite rotation mathematically matches the target rotation", () => {
    // 任意の軸と角度で目標回転を作成 (例: X軸とY軸の中間を軸に90度回転)
    const axis = new THREE.Vector3(1, 1, 0).normalize();
    const angle = Math.PI / 2;
    const targetRotation = new THREE.Quaternion().setFromAxisAngle(axis, angle);

    // 重み（合計1）
    const weights: [number, number, number] = [0.2, 0.3, 0.5];
    const [q0, q1, q2] = distributeSpineRotation(targetRotation, weights);

    // テスト1: 個々の分配が正しいことを数学的に導出
    // slerpは回転角を線形補間するため、同じ軸に対して angle * weight の回転になる
    const expectedQ0 = new THREE.Quaternion().setFromAxisAngle(axis, angle * weights[0]);
    const expectedQ1 = new THREE.Quaternion().setFromAxisAngle(axis, angle * weights[1]);
    const expectedQ2 = new THREE.Quaternion().setFromAxisAngle(axis, angle * weights[2]);

    expect(q0.angleTo(expectedQ0)).toBeCloseTo(0);
    expect(q1.angleTo(expectedQ1)).toBeCloseTo(0);
    expect(q2.angleTo(expectedQ2)).toBeCloseTo(0);

    // テスト2: 分配後の3ボーンの合成回転が分配前の目標回転と一致すること
    // 同じ軸の回転は可換であり、合成は単純な積で求まる
    const compositeRotation = new THREE.Quaternion().copy(q0).multiply(q1).multiply(q2);
    expect(compositeRotation.angleTo(targetRotation)).toBeCloseTo(0);
  });

  it("uses default weights [1/3, 1/3, 1/3] if not provided", () => {
    const axis = new THREE.Vector3(0, 1, 0);
    const angle = Math.PI / 3;
    const targetRotation = new THREE.Quaternion().setFromAxisAngle(axis, angle);

    const [q0, q1, q2] = distributeSpineRotation(targetRotation);

    const expectedQ = new THREE.Quaternion().setFromAxisAngle(axis, angle / 3);

    expect(q0.angleTo(expectedQ)).toBeCloseTo(0);
    expect(q1.angleTo(expectedQ)).toBeCloseTo(0);
    expect(q2.angleTo(expectedQ)).toBeCloseTo(0);

    const compositeRotation = new THREE.Quaternion().copy(q0).multiply(q1).multiply(q2);
    expect(compositeRotation.angleTo(targetRotation)).toBeCloseTo(0);
  });
});
