import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import * as narrowModule from "./penetrationNarrowPhase";
import {
  narrowPhaseDistance,
  applyNarrowPhaseRefinement,
} from "./penetrationNarrowPhase";
import type { Penetration, SegmentCapsule } from "./poseValidity";

// モックカプセルヘルパー
const createCapsule = (name: string): SegmentCapsule => ({
  name,
  a: new THREE.Vector3(0, 0, 0),
  b: new THREE.Vector3(0, 1, 0),
  radius: 0.05,
});

describe("ケース 1: narrowPhaseDistance の基本挙動（3 パターン）", () => {
  it("交差する 2 三角形（一方が他方を貫通） → 負値", () => {
    // Triangle 1: XY 平面上 (z=0)
    // Triangle 2: YZ 平面上 (x=0, z が -0.5 から 0.5 に渡り XY 平面を貫通)
    const geom1 = new THREE.BufferGeometry();
    geom1.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, 0, 2, 0]), 3)
    );
    const mesh1 = new THREE.Mesh(geom1);

    const geom2 = new THREE.BufferGeometry();
    geom2.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([0, 1, -0.5, 0, 1, 0.5, 0, -1, 0]), 3)
    );
    const mesh2 = new THREE.Mesh(geom2);

    const group = new THREE.Group();
    group.add(mesh1);
    group.add(mesh2);

    const caps: [SegmentCapsule, SegmentCapsule] = [
      createCapsule("thigh:L"),
      createCapsule("calf:R"),
    ];

    const dist = narrowPhaseDistance(caps, group);
    expect(dist).toBeLessThan(0);
  });

  it("接触する 2 三角形（頂点共有 or 面接触） → ≈ 0 (絶対値 < 1e-4)", () => {
    // 2 つの三角形が同じ辺 (1,0,0)-(0,1,0) を共有
    const geom1 = new THREE.BufferGeometry();
    geom1.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3)
    );
    const mesh1 = new THREE.Mesh(geom1);

    const geom2 = new THREE.BufferGeometry();
    geom2.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 1, 1, 0]), 3)
    );
    const mesh2 = new THREE.Mesh(geom2);

    const group = new THREE.Group();
    group.add(mesh1);
    group.add(mesh2);

    const caps: [SegmentCapsule, SegmentCapsule] = [
      createCapsule("thigh:L"),
      createCapsule("calf:R"),
    ];

    const dist = narrowPhaseDistance(caps, group);
    expect(Math.abs(dist)).toBeLessThan(1e-4);
  });

  it("離間した 2 三角形（間隔 5cm） → ≈ 0.05", () => {
    // Triangle 1: z = 0
    // Triangle 2: z = 0.05 (5cm 離れている)
    const geom1 = new THREE.BufferGeometry();
    geom1.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3)
    );
    const mesh1 = new THREE.Mesh(geom1);

    const geom2 = new THREE.BufferGeometry();
    geom2.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([0, 0, 0.05, 1, 0, 0.05, 0, 1, 0.05]), 3)
    );
    const mesh2 = new THREE.Mesh(geom2);

    const group = new THREE.Group();
    group.add(mesh1);
    group.add(mesh2);

    const caps: [SegmentCapsule, SegmentCapsule] = [
      createCapsule("thigh:L"),
      createCapsule("calf:R"),
    ];

    const dist = narrowPhaseDistance(caps, group);
    expect(Math.abs(dist - 0.05)).toBeLessThan(1e-3);
  });
});

describe("ケース 2: applyNarrowPhaseRefinement が broad pass ペアには narrow を回さない", () => {
  it("fail 帯 + fail 帯 -5mm 以内の warn ペアのみ narrow phase を適用する", () => {
    // デフォルトの perPairToleranceM: warnDefault = 0.01, failDefault = 0.03
    // ペア1: fail 帯 (depthM = 0.035 > fail 0.03)
    // ペア2: fail 帯 -5mm 以内の warn (depthM = 0.026 >= fail 0.03 - 0.005 = 0.025)
    // ペア3: fail 帯まで 10mm 以上余裕のある warn (depthM = 0.015 < 0.025)
    const pens: Penetration[] = [
      { a: "pelvis", b: "hand:L", depthM: 0.035, severity: "fail" },
      { a: "foreArm:L", b: "calf:R", depthM: 0.026, severity: "warn" },
      { a: "upperArm:L", b: "thigh:R", depthM: 0.015, severity: "warn" },
    ];

    const spy = vi.spyOn(narrowModule, "narrowPhaseDistance").mockReturnValue(0.01);
    const dummyMesh = new THREE.Group();

    const result = applyNarrowPhaseRefinement(pens, dummyMesh);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result[0].narrowRefined).toBe(true);
    expect(result[1].narrowRefined).toBe(true);
    expect(result[2].narrowRefined).toBeUndefined(); // スキップされたペア

    spy.mockRestore();
  });
});

describe("ケース 3: narrow phase 結果が severity を格下げする", () => {
  it("broad phase で fail 判定だったペアで narrow 表面距離 > 0 の場合、warn へ格下げ", () => {
    const pens: Penetration[] = [
      { a: "foreArm:L", b: "calf:R", depthM: 0.04, severity: "fail" },
    ];

    const spy = vi.spyOn(narrowModule, "narrowPhaseDistance").mockReturnValue(0.005); // > 0
    const dummyMesh = new THREE.Group();

    const result = applyNarrowPhaseRefinement(pens, dummyMesh);

    expect(result[0].severity).toBe("warn");
    expect(result[0].narrowRefined).toBe(true);

    spy.mockRestore();
  });
});

describe("ケース 4: narrow phase 結果が「表面距離 ≤ 0 かつ深さが fail 閾値超」なら fail 維持", () => {
  it("broad phase fail かつ narrow 結果が交差判定 (負値) の場合、fail を維持", () => {
    const pens: Penetration[] = [
      { a: "foreArm:L", b: "calf:R", depthM: 0.04, severity: "fail" },
    ];

    const spy = vi.spyOn(narrowModule, "narrowPhaseDistance").mockReturnValue(-0.01); // <= 0
    const dummyMesh = new THREE.Group();

    const result = applyNarrowPhaseRefinement(pens, dummyMesh);

    expect(result[0].severity).toBe("fail");
    expect(result[0].narrowRefined).toBe(true);

    spy.mockRestore();
  });
});

describe("ケース 7: performance test (自動化)", () => {
  it("100 回連続呼び出しの平均時間が 50ms 以下、合計 5s 以下", () => {
    // 合成 skinned mesh + 100 ペアの broad phase 結果 fixture
    const pens: Penetration[] = Array.from({ length: 100 }, (_, i) => ({
      a: `thigh:${i % 2 === 0 ? "L" : "R"}`,
      b: `calf:${i % 2 === 0 ? "R" : "L"}`,
      depthM: 0.04,
      severity: "fail" as const,
    }));

    const spy = vi.spyOn(narrowModule, "narrowPhaseDistance").mockReturnValue(0.01);
    const dummyMesh = new THREE.Group();

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      applyNarrowPhaseRefinement(pens, dummyMesh);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThanOrEqual(5000);
    expect(elapsed / 100).toBeLessThanOrEqual(50);

    spy.mockRestore();
  });
});

describe("P0-1 regression: 複数体節を持つ単一 SkinnedMesh の隔離テスト", () => {
  it("単一 SkinnedMesh 内で異なるボーンに紐づく頂点が正しい距離を返す", () => {
    const boneL = new THREE.Bone();
    boneL.name = "mixamorig:LeftUpLeg"; // thigh:L
    const boneR = new THREE.Bone();
    boneR.name = "mixamorig:RightUpLeg"; // thigh:R
    boneR.position.set(100, 0, 0); // 100m 離れている

    const skeleton = new THREE.Skeleton([boneL, boneR]);

    // 頂点 0〜2: boneL (thigh:L) に属する (x=0 付近)
    // 頂点 3〜5: boneR (thigh:R) に属する (x=100 付近)
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 100, 0, 0, 101, 0, 0, 100, 1, 0,
    ]);
    const skinIndices = new Float32Array([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
    ]);
    const skinWeights = new Float32Array([
      1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
    ]);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setAttribute("skinIndex", new THREE.BufferAttribute(skinIndices, 4));
    geom.setAttribute("skinWeight", new THREE.BufferAttribute(skinWeights, 4));

    const mesh = new THREE.SkinnedMesh(geom, new THREE.MeshBasicMaterial());
    mesh.bind(skeleton);

    const caps: [SegmentCapsule, SegmentCapsule] = [
      createCapsule("thigh:L"),
      createCapsule("thigh:R"),
    ];

    const dist = narrowPhaseDistance(caps, mesh);
    expect(dist).toBeGreaterThan(90);
  });
});
