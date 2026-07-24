import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { LM, type RawLandmark } from "./muscles";
import type { GoldenPose } from "./golden";
import {
  checkGoldenRom,
  checkPalmsFlat,
  computeContactClearances,
  romLimitFor,
  segmentDistance,
  buildBodyCapsules,
  detectSelfPenetrations,
  compareLandmarkPoses,
  SELF_PENETRATION,
  CAPSULE_SPECS,
  EXCLUDED_PAIRS,
  type SegmentCapsule,
  BODY_SEGMENT_MASS,
  STABILITY,
  computeCOM,
  computeSupportPolygon,
  checkStability,
  signedDistanceToPolygon,
  isPenetrationPass,
  type Penetration,
} from "./poseValidity";

/** #128 テスト用の単純なカプセル生成ヘルパ（既存 describe 内の同等ヘルパとは別スコープ） */
const makeCapsule = (
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
    // 前腕が胸部軸を貫通（距離 0、半径和 0.17）→ 深さ 0.17 > 許容 0.03
    const caps = [
      capsule("chest", 0, 0, 0, 0, 0.5, 0, 0.13),
      capsule("foreArm:L", -0.2, 0.25, 0, 0.2, 0.25, 0, 0.04),
    ];
    const pens = detectSelfPenetrations(caps);
    expect(pens).toHaveLength(1);
    expect(pens[0].depthM).toBeCloseTo(0.17, 5);
  });

  it("allows light contact within the tolerance", () => {
    // 表面同士がちょうど接する（距離 = 半径和）→ 深さ 0
    const caps = [
      capsule("chest", 0, 0, 0, 0, 0.5, 0, 0.13),
      capsule("foreArm:L", -0.2, 0.25, 0.17, 0.2, 0.25, 0.17, 0.04),
    ];
    expect(detectSelfPenetrations(caps)).toHaveLength(0);
  });

  it("skips excluded adjacent pairs (chest × upperArm)", () => {
    const caps = [
      capsule("chest", 0, 0, 0, 0, 0.5, 0, 0.13),
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

describe("computeContactClearances (#90)", () => {
  // 原点のボーンに、指定 Y のスキン頂点を紐づけた簡易 SkinnedMesh。
  // ボーンを原点に固定し高さは頂点側で表現する（bind を identity に保つ）。
  const buildFootRig = (kneeY: number) => {
    const root = new THREE.Group();
    const leg = new THREE.Bone();
    leg.name = "mixamorig:LeftLeg";
    root.add(leg);
    root.updateMatrixWorld(true);
    const geom = new THREE.BufferGeometry();
    const pos = new Float32Array([0, kneeY, 0, 0.05, kneeY + 0.02, 0]);
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute(
      "skinIndex",
      new THREE.BufferAttribute(new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0]), 4)
    );
    geom.setAttribute(
      "skinWeight",
      new THREE.BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0]), 4)
    );
    const mesh = new THREE.SkinnedMesh(geom, new THREE.MeshBasicMaterial());
    mesh.bind(new THREE.Skeleton([leg]));
    root.add(mesh);
    root.updateMatrixWorld(true);
    return root;
  };

  it("marks a grounded part as grounded (clearance ≈ 0)", () => {
    const root = buildFootRig(-1); // knee vertices at floor y=-1
    const res = computeContactClearances(root, ["knee:L"], -1);
    expect(res).toHaveLength(1);
    expect(res[0].clearanceM).toBeLessThan(0.05);
    expect(res[0].grounded).toBe(true);
  });

  it("flags a floating part", () => {
    const root = buildFootRig(-0.7); // knee vertices 30cm above floor
    const res = computeContactClearances(root, ["knee:L"], -1);
    expect(res[0].clearanceM).toBeGreaterThan(0.25);
    expect(res[0].grounded).toBe(false);
  });

  it("skips unknown parts", () => {
    const root = buildFootRig(-1);
    expect(computeContactClearances(root, ["nonsense"], -1)).toHaveLength(0);
  });
});

describe("checkPalmsFlat (#90)", () => {
  // 平面的な点群を持つ Hand メッシュ。normal 方向で厚みを制御
  const buildHandRig = (normal: THREE.Vector3) => {
    const root = new THREE.Group();
    const hand = new THREE.Bone();
    hand.name = "mixamorig:LeftHand";
    root.add(hand);
    // normal に直交する 2 軸で広がり、normal 方向に薄い点群
    const u = new THREE.Vector3(1, 0, 0);
    if (Math.abs(normal.dot(u)) > 0.9) u.set(0, 1, 0);
    const e1 = new THREE.Vector3().crossVectors(normal, u).normalize();
    const e2 = new THREE.Vector3().crossVectors(normal, e1).normalize();
    const pts: number[] = [];
    for (let a = -2; a <= 2; a++)
      for (let b = -2; b <= 2; b++) {
        const p = e1
          .clone()
          .multiplyScalar(a * 0.03)
          .add(e2.clone().multiplyScalar(b * 0.03));
        pts.push(p.x, p.y, p.z);
      }
    const n = pts.length / 3;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
    geom.setAttribute("skinIndex", new THREE.BufferAttribute(new Uint16Array(n * 4), 4));
    geom.setAttribute(
      "skinWeight",
      new THREE.BufferAttribute(
        new Float32Array(Array.from({ length: n }, () => [1, 0, 0, 0]).flat()),
        4
      )
    );
    const mesh = new THREE.SkinnedMesh(geom, new THREE.MeshBasicMaterial());
    mesh.bind(new THREE.Skeleton([hand]));
    root.add(mesh);
    root.updateMatrixWorld(true);
    return root;
  };

  it("passes a horizontal hand (palm/back parallel to floor)", () => {
    const root = buildHandRig(new THREE.Vector3(0, 1, 0)); // normal vertical = flat
    const res = checkPalmsFlat(root, ["left"]);
    expect(res).toHaveLength(1);
    expect(res[0].tiltDeg).toBeLessThan(10);
    expect(res[0].flat).toBe(true);
  });

  it("fails a vertical hand (fingertip stand: slab normal horizontal)", () => {
    const root = buildHandRig(new THREE.Vector3(0, 0, 1)); // normal horizontal = tilted
    const res = checkPalmsFlat(root, ["left"]);
    expect(res[0].tiltDeg).toBeGreaterThan(60);
    expect(res[0].flat).toBe(false);
  });
});

describe("BODY_SEGMENT_MASS (#117 ケース6)", () => {
  it("sums to approximately 1.0（Winter モデルの端数誤差を許容）", () => {
    const sum = Object.values(BODY_SEGMENT_MASS).reduce((s, v) => s + v, 0);
    expect(sum).toBeGreaterThanOrEqual(0.98);
    expect(sum).toBeLessThanOrEqual(1.02);
  });
});

/**
 * 支持点の候補ボーンのみを持つ最小リグ（#117 ケース3・4）。
 * 各足を LeftToeBase/RightToeBase の 1 ボーンだけで表現するため
 * （LeftFoot 等の別名ボーンを持たない）、"toe:L"/"toe:R" はそれぞれ
 * 1 点にしか解決されず、支持多角形は退化した 2 頂点（両つま先）になる。
 */
const buildMinimalContactRig = () => {
  const root = new THREE.Group();
  const leftToe = new THREE.Bone();
  leftToe.name = "LeftToeBase";
  leftToe.position.set(0.1, 0, 0.1);
  const rightToe = new THREE.Bone();
  rightToe.name = "RightToeBase";
  rightToe.position.set(-0.1, 0, 0.1);
  root.add(leftToe, rightToe);
  root.updateMatrixWorld(true);
  return { root, leftToe, rightToe };
};

describe("computeSupportPolygon (#117)", () => {
  it("excludes an unexpected incidental contact (arm touching the floor) from usedBones/polygon (ケース3)", () => {
    const { root } = buildMinimalContactRig();
    const result = computeSupportPolygon(
      root,
      ["toe:L", "toe:R"],
      ["toe:L", "toe:R", "hand:L"]
    );
    expect(result.usedBones).not.toContain("hand:L");
    expect(result.polygon).toHaveLength(2);
  });

  it("excludes an expected contact that is not actually grounded from usedBones (ケース4)", () => {
    const { root } = buildMinimalContactRig();
    const result = computeSupportPolygon(
      root,
      ["toe:L", "toe:R", "hand:L"],
      ["toe:L", "toe:R"]
    );
    expect(result.usedBones).not.toContain("hand:L");
    expect(result.expectedBones).toContain("hand:L");
  });
});

/**
 * 対称立位の全身リグ（#117 ケース1・2・5）。y-up、floorY=0。
 * 足は「ボーン位置（Foot=足首相当）」と「ToeBase（爪先、前方）」の 2 点で
 * 表現し、支持多角形に前後の実面積を持たせる（Foot はやや後方 z=-0.05、
 * ToeBase は前方 z=0.10）。接地判定（computeContactClearances）用に、
 * 各足ボーンへ完全ウェイトした頂点を持つ 1 枚の SkinnedMesh を bind する
 * （bind 時点ではボーン変形デルタが恒等なので、頂点の world 座標は
 * authored したローカル座標そのものになる — skinnedMannequin.test.ts 等の
 * 既存パターンと同じ仕組み）。
 */
const buildStandingRig = () => {
  const root = new THREE.Group();
  const makeBone = (name: string): THREE.Bone => {
    const b = new THREE.Bone();
    b.name = name;
    return b;
  };

  const hips = makeBone("Hips");
  hips.position.set(0, 1.0, 0);
  root.add(hips);

  const spine = makeBone("Spine");
  spine.position.set(0, 0.25, 0);
  hips.add(spine);
  const neck = makeBone("Neck");
  neck.position.set(0, 0.3, 0);
  spine.add(neck);
  const head = makeBone("Head");
  head.position.set(0, 0.13, 0);
  neck.add(head);

  const leftArm = makeBone("LeftArm");
  leftArm.position.set(0.2, 0.2, 0);
  hips.add(leftArm);
  const leftForeArm = makeBone("LeftForeArm");
  leftForeArm.position.set(0, -0.3, 0);
  leftArm.add(leftForeArm);
  const leftHand = makeBone("LeftHand");
  leftHand.position.set(0, -0.25, 0);
  leftForeArm.add(leftHand);

  const rightArm = makeBone("RightArm");
  rightArm.position.set(-0.2, 0.2, 0);
  hips.add(rightArm);
  const rightForeArm = makeBone("RightForeArm");
  rightForeArm.position.set(0, -0.3, 0);
  rightArm.add(rightForeArm);
  const rightHand = makeBone("RightHand");
  rightHand.position.set(0, -0.25, 0);
  rightForeArm.add(rightHand);

  const leftUpLeg = makeBone("LeftUpLeg");
  leftUpLeg.position.set(0.1, -0.05, 0);
  hips.add(leftUpLeg);
  const leftLeg = makeBone("LeftLeg");
  leftLeg.position.set(0, -0.45, 0);
  leftUpLeg.add(leftLeg);
  const leftFoot = makeBone("LeftFoot");
  leftFoot.position.set(0, -0.45, -0.03);
  leftLeg.add(leftFoot);
  const leftToeBase = makeBone("LeftToeBase");
  leftToeBase.position.set(0, -0.05, 0.08);
  leftFoot.add(leftToeBase);

  const rightUpLeg = makeBone("RightUpLeg");
  rightUpLeg.position.set(-0.1, -0.05, 0);
  hips.add(rightUpLeg);
  const rightLeg = makeBone("RightLeg");
  rightLeg.position.set(0, -0.45, 0);
  rightUpLeg.add(rightLeg);
  const rightFoot = makeBone("RightFoot");
  rightFoot.position.set(0, -0.45, -0.03);
  rightLeg.add(rightFoot);
  const rightToeBase = makeBone("RightToeBase");
  rightToeBase.position.set(0, -0.05, 0.08);
  rightFoot.add(rightToeBase);

  root.updateMatrixWorld(true);

  const allBones = [
    hips,
    spine,
    neck,
    head,
    leftArm,
    leftForeArm,
    leftHand,
    rightArm,
    rightForeArm,
    rightHand,
    leftUpLeg,
    leftLeg,
    leftFoot,
    leftToeBase,
    rightUpLeg,
    rightLeg,
    rightFoot,
    rightToeBase,
  ];

  // 接地判定用の足スキンメッシュ。各頂点は単一ボーンへ完全ウェイトし、
  // floorY=0 に接する高さ（y=0）で配置する（x/z はボーン位置に揃える）。
  const footVerts: [THREE.Bone, number, number][] = [
    [leftFoot, 0.1, -0.03],
    [leftToeBase, 0.1, 0.05],
    [rightFoot, -0.1, -0.03],
    [rightToeBase, -0.1, 0.05],
  ];
  const positions: number[] = [];
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  for (const [bone, x, z] of footVerts) {
    positions.push(x, 0, z);
    const boneIdx = allBones.indexOf(bone);
    skinIndices.push(boneIdx, 0, 0, 0);
    skinWeights.push(1, 0, 0, 0);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(positions), 3)
  );
  geom.setAttribute(
    "skinIndex",
    new THREE.BufferAttribute(new Uint16Array(skinIndices), 4)
  );
  geom.setAttribute(
    "skinWeight",
    new THREE.BufferAttribute(new Float32Array(skinWeights), 4)
  );
  const mesh = new THREE.SkinnedMesh(geom, new THREE.MeshBasicMaterial());
  mesh.bind(new THREE.Skeleton(allBones));
  root.add(mesh);
  root.updateMatrixWorld(true);

  return { root, hips, spine };
};

describe("computeCOM (#117)", () => {
  it("places the COM near the hips for a symmetric standing pose", () => {
    const { root } = buildStandingRig();
    const com = computeCOM(root);
    // 左右対称なので X は 0、Y は Hips 高さ付近（腕・脚の質量が上下に相殺し合う）
    expect(com.xz.x).toBeCloseTo(0, 5);
    expect(com.world.y).toBeGreaterThan(0.8);
    expect(com.world.y).toBeLessThan(1.2);
  });
});

describe("checkStability (#117)", () => {
  it("passes for a symmetric standing pose with both feet grounded (ケース1)", () => {
    const { root } = buildStandingRig();
    const result = checkStability(root, ["toe:L", "toe:R"], 0);
    expect(result.pass).toBe(true);
    expect(result.distanceToBoundaryM).toBeGreaterThan(STABILITY.marginM);
    expect(result.supportBones).toHaveLength(2);
  });

  it("fails single-foot support: degenerate support polygon (ケース2)", () => {
    const { root } = buildStandingRig();
    const result = checkStability(root, ["toe:L"], 0);
    expect(result.pass).toBe(false);
    expect(result.supportPolygon.length).toBeLessThan(3);
  });

  it("fails when the COM is pitched outside the support polygon by a deep forward lean (ケース5)", () => {
    const { root, spine } = buildStandingRig();
    spine.quaternion.setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      THREE.MathUtils.degToRad(75)
    );
    root.updateMatrixWorld(true);
    const result = checkStability(root, ["toe:L", "toe:R"], 0);
    expect(result.pass).toBe(false);
    expect(result.distanceToBoundaryM).toBeLessThan(-0.02);
  });

  it("fails regardless of a negative marginM when the support polygon is degenerate and the COM sits within 1cm of it (ケース8・codex P2 回帰)", () => {
    // 支持多角形頂点1個（LeftToeBase）かつ COM が水平距離 1cm の直近にある
    // 最小リグ。STABILITY.marginM = -0.04 のもとでは
    // distanceToBoundaryM(-0.01) > marginM(-0.04) が成立してしまうため、
    // 縮退判定を分離する前は誤って pass していた（#118 codex レビュー指摘 P2）。
    const root = new THREE.Group();
    const spine = new THREE.Bone();
    spine.name = "Spine";
    spine.position.set(0.1, 1.0, 0.1);
    root.add(spine);
    const neck = new THREE.Bone();
    neck.name = "Neck";
    // オフセット0で spine と同位置に置き、trunk 質点（唯一解決できる分節）の
    // XZ を spine 位置に集中させる（他の分節ボーンは存在しないため
    // COM ≈ trunk 中点 = spine のワールド位置になる）。
    spine.add(neck);

    const toe = new THREE.Bone();
    toe.name = "LeftToeBase";
    // COM の XZ (0.1, 0.1) から水平距離ちょうど 1cm の位置に単一支持点を置く
    toe.position.set(0.11, 0, 0.1);
    root.add(toe);
    root.updateMatrixWorld(true);

    // 接地判定用の頂点（floorY=0 に接する y=0。x/z は clearance 判定に無関係
    // — bind 時点でポーズ変形デルタが恒等なので、頂点 world 座標は authored
    // したローカル座標そのものになる）。
    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3)
    );
    geom.setAttribute(
      "skinIndex",
      new THREE.BufferAttribute(new Uint16Array([0, 0, 0, 0]), 4)
    );
    geom.setAttribute(
      "skinWeight",
      new THREE.BufferAttribute(new Float32Array([1, 0, 0, 0]), 4)
    );
    const mesh = new THREE.SkinnedMesh(geom, new THREE.MeshBasicMaterial());
    mesh.bind(new THREE.Skeleton([toe]));
    root.add(mesh);
    root.updateMatrixWorld(true);

    const result = checkStability(root, ["toe:L"], 0);

    expect(result.supportPolygon.length).toBeLessThan(3);
    expect(result.distanceToBoundaryM).toBeCloseTo(-0.01, 3);
    // marginM (-0.04) より内側（distanceToBoundaryM > marginM）でも、縮退で
    // あれば pass にならない（診断情報の distanceToBoundaryM 自体は残る）。
    expect(result.distanceToBoundaryM).toBeGreaterThan(STABILITY.marginM);
    expect(result.pass).toBe(false);
  });
});

/**
 * codex レビュー指摘 P2 の回帰テスト（#117）。
 *
 * 単位正方形（頂点 (0,0)-(1,0)-(1,1)-(0,1)）。頂点順は
 * signedDistanceToPolygon が前提とする「時計回り（内側 = 各辺の右側）」
 * 規約に合わせて [(0,1),(1,1),(1,0),(0,0)] とする（convexHull2D がこの
 * 座標集合に対して実際に生成する巻き順と一致させたもの）。
 */
describe("signedDistanceToPolygon (#117 codex P2 回帰)", () => {
  const unitSquareCW = [
    { x: 0, z: 1 },
    { x: 1, z: 1 },
    { x: 1, z: 0 },
    { x: 0, z: 0 },
  ];

  it("returns the distance to the nearest vertex for a point outside a corner (ケース7)", () => {
    // バグ修正前は「右辺 x=1 を延長した直線までの距離 = 1」を誤って返していた。
    // 正しくは頂点 (1,1) までの最短距離 √2。
    const d = signedDistanceToPolygon({ x: 2, z: 2 }, unitSquareCW);
    expect(d).toBeCloseTo(-Math.sqrt(2), 6);
  });

  it("returns the correct positive margin for a point at the polygon center", () => {
    const d = signedDistanceToPolygon({ x: 0.5, z: 0.5 }, unitSquareCW);
    expect(d).toBeCloseTo(0.5, 6);
  });
});

describe("ケース 1: SELF_PENETRATION.radiusM に新 capsule が定義される", () => {
  it("defines chest, abdomen, pelvis, hand radii", () => {
    const keys = ["chest", "abdomen", "pelvis", "hand"] as const;
    for (const key of keys) {
      expect(typeof (SELF_PENETRATION.radiusM as Record<string, number>)[key]).toBe(
        "number"
      );
      expect((SELF_PENETRATION.radiusM as Record<string, number>)[key]).toBeGreaterThan(
        0
      );
    }
  });
});

describe("ケース 2: CAPSULE_SPECS に新 capsule spec が含まれる", () => {
  it("contains chest, abdomen, pelvis, hand:L, hand:R and no torso", () => {
    const names = CAPSULE_SPECS.map((s) => s.name);
    expect(names).toContain("chest");
    expect(names).toContain("abdomen");
    expect(names).toContain("pelvis");
    expect(names).toContain("hand:L");
    expect(names).toContain("hand:R");
    expect(names).not.toContain("torso");
  });
});

describe("ケース 3: buildBodyCapsules が新 capsule 全てを生成する（simple skeleton fixture）", () => {
  it("generates chest, abdomen, pelvis, hand:L, hand:R capsules", () => {
    const root = new THREE.Group();
    const makeBone = (name: string) => {
      const b = new THREE.Bone();
      b.name = name;
      return b;
    };
    const hips = makeBone("mixamorig:Hips");
    const spine = makeBone("mixamorig:Spine");
    const spine1 = makeBone("mixamorig:Spine1");
    const neck = makeBone("mixamorig:Neck");
    const head = makeBone("mixamorig:Head");
    const headTop = makeBone("mixamorig:HeadTop");

    const leftArm = makeBone("mixamorig:LeftArm");
    const leftForeArm = makeBone("mixamorig:LeftForeArm");
    const leftHand = makeBone("mixamorig:LeftHand");
    const leftHandTop = makeBone("mixamorig:LeftHandTop");
    const leftHandMiddle = makeBone("mixamorig:LeftHandMiddle1");

    const rightArm = makeBone("mixamorig:RightArm");
    const rightForeArm = makeBone("mixamorig:RightForeArm");
    const rightHand = makeBone("mixamorig:RightHand");
    const rightHandTop = makeBone("mixamorig:RightHandTop");
    const rightHandMiddle = makeBone("mixamorig:RightHandMiddle1");

    const leftUpLeg = makeBone("mixamorig:LeftUpLeg");
    const leftLeg = makeBone("mixamorig:LeftLeg");
    const leftFoot = makeBone("mixamorig:LeftFoot");
    const leftToeBase = makeBone("mixamorig:LeftToeBase");

    const rightUpLeg = makeBone("mixamorig:RightUpLeg");
    const rightLeg = makeBone("mixamorig:RightLeg");
    const rightFoot = makeBone("mixamorig:RightFoot");
    const rightToeBase = makeBone("mixamorig:RightToeBase");

    hips.add(spine);
    spine.add(spine1);
    spine1.add(neck);
    neck.add(head);
    head.add(headTop);

    spine1.add(leftArm);
    leftArm.add(leftForeArm);
    leftForeArm.add(leftHand);
    leftHand.add(leftHandTop);
    leftHand.add(leftHandMiddle);

    spine1.add(rightArm);
    rightArm.add(rightForeArm);
    rightForeArm.add(rightHand);
    rightHand.add(rightHandTop);
    rightHand.add(rightHandMiddle);

    hips.add(leftUpLeg);
    leftUpLeg.add(leftLeg);
    leftLeg.add(leftFoot);
    leftFoot.add(leftToeBase);

    hips.add(rightUpLeg);
    rightUpLeg.add(rightLeg);
    rightLeg.add(rightFoot);
    rightFoot.add(rightToeBase);

    root.add(hips);
    root.updateMatrixWorld(true);

    const caps = buildBodyCapsules(root);
    const names = caps.map((c) => c.name);
    expect(names).toContain("chest");
    expect(names).toContain("abdomen");
    expect(names).toContain("pelvis");
    expect(names).toContain("hand:L");
    expect(names).toContain("hand:R");
  });
});

describe("追加テスト: hand capsule endpoint 検証 / 検知バグ: children[0] フォールバックが人差し指に外れる", () => {
  it("uses LeftHandMiddle1 / RightHandMiddle1 for hand capsule b endpoint", () => {
    const root = new THREE.Group();
    const makeBone = (name: string, x: number, y: number, z: number) => {
      const b = new THREE.Bone();
      b.name = name;
      b.position.set(x, y, z);
      return b;
    };
    const handL = makeBone("mixamorig:LeftHand", 1, 0, 0);
    // 人差し指 (index_01_l) を children[0] に配置
    const indexL = makeBone("index_01_l", 0, 0.1, 0);
    // 中指 (middle_01_l) を children[1] に配置
    const middleL = makeBone("middle_01_l", 0.05, 0, 0);
    handL.add(indexL);
    handL.add(middleL);

    root.add(handL);
    root.updateMatrixWorld(true);

    const caps = buildBodyCapsules(root);
    const handCapsuleL = caps.find((c) => c.name === "hand:L");
    expect(handCapsuleL).toBeDefined();

    const expectedB = middleL.getWorldPosition(new THREE.Vector3());
    expect(handCapsuleL!.b.distanceTo(expectedB)).toBeLessThan(1e-6);
  });
});

describe("ケース 4: EXCLUDED_PAIRS から広域除外が消えている", () => {
  it("returns false for removed wide exclusions", () => {
    expect(EXCLUDED_PAIRS.has(["torso", "thigh:L"].sort().join("|"))).toBe(false);
    expect(EXCLUDED_PAIRS.has(["thigh:L", "thigh:R"].sort().join("|"))).toBe(false);
    expect(EXCLUDED_PAIRS.has(["head", "upperArm:L"].sort().join("|"))).toBe(false);
    expect(EXCLUDED_PAIRS.has(["head", "upperArm:R"].sort().join("|"))).toBe(false);
  });
});

describe("ケース 5: EXCLUDED_PAIRS に隣接ペアが残っている", () => {
  it("returns true for required adjacent pairs", () => {
    const pairs = [
      ["chest", "abdomen"],
      ["abdomen", "pelvis"],
      ["chest", "pelvis"],
      ["chest", "head"],
      ["chest", "upperArm:L"],
      ["chest", "upperArm:R"],
      ["pelvis", "thigh:L"],
      ["pelvis", "thigh:R"],
      ["abdomen", "thigh:L"],
      ["abdomen", "thigh:R"],
      ["foreArm:L", "hand:L"],
      ["foreArm:R", "hand:R"],
      ["upperArm:L", "foreArm:L"],
      ["upperArm:R", "foreArm:R"],
      ["thigh:L", "calf:L"],
      ["thigh:R", "calf:R"],
      ["calf:L", "foot:L"],
      ["calf:R", "foot:R"],
    ];
    for (const p of pairs) {
      const key = p.sort().join("|");
      expect(EXCLUDED_PAIRS.has(key)).toBe(true);
    }
  });
});

describe("#128 ケース 1: Penetration 型に severity が追加されている", () => {
  it("accepts severity 'warn' | 'fail' alongside the existing a/b/depthM fields", () => {
    const warnPen: Penetration = {
      a: "chest",
      b: "foreArm:L",
      depthM: 0.02,
      severity: "warn",
    };
    const failPen: Penetration = {
      a: "chest",
      b: "foreArm:L",
      depthM: 0.07,
      severity: "fail",
    };
    expect(warnPen.severity).toBe("warn");
    expect(failPen.severity).toBe("fail");
    expect(warnPen.a).toBe("chest");
    expect(warnPen.b).toBe("foreArm:L");
  });
});

describe("#128 ケース 2: SELF_PENETRATION.perPairToleranceM の構造", () => {
  it("defines warnDefault/failDefault and overrides for the known absorbed pairs", () => {
    expect(SELF_PENETRATION.perPairToleranceM.warnDefault).toBe(0.01);
    expect(SELF_PENETRATION.perPairToleranceM.failDefault).toBe(0.03);
    const overrides = SELF_PENETRATION.perPairToleranceM.overrides as Record<
      string,
      { warn: number; fail: number }
    >;
    for (const key of [
      "thigh:L|thigh:R",
      "hand:L|hand:R",
      "foreArm:L|hand:R",
      "foreArm:R|hand:L",
    ]) {
      expect(overrides[key]).toBeDefined();
      expect(typeof overrides[key].warn).toBe("number");
      expect(typeof overrides[key].fail).toBe("number");
    }
  });
});

describe("#128 ケース 3: detectSelfPenetrations が warn/fail/許容の 3 帯を判定する", () => {
  // chest（半径 0.13）× calf:L（半径 0.055）: overrides 未該当ペアで
  // warnDefault(0.01) / failDefault(0.03) がそのまま適用されることを確認する
  it("returns severity 'warn' when depth is within the warn band (default tolerance)", () => {
    const caps = [
      makeCapsule("chest", 0, 0, 0, 0, 0, 0, SELF_PENETRATION.radiusM.chest),
      // 半径和 0.185、depth = 0.185 - dist = 0.02 になるよう dist=0.165
      makeCapsule("calf:L", 0.165, 0, 0, 0.165, 0, 0, SELF_PENETRATION.radiusM.calf),
    ];
    const pens = detectSelfPenetrations(caps);
    expect(pens).toHaveLength(1);
    expect(pens[0].depthM).toBeCloseTo(0.02, 5);
    expect(pens[0].severity).toBe("warn");
  });

  it("returns severity 'fail' when depth exceeds the fail band (default tolerance)", () => {
    const caps = [
      makeCapsule("chest", 0, 0, 0, 0, 0, 0, SELF_PENETRATION.radiusM.chest),
      // depth = 0.185 - dist = 0.05 になるよう dist=0.135
      makeCapsule("calf:L", 0.135, 0, 0, 0.135, 0, 0, SELF_PENETRATION.radiusM.calf),
    ];
    const pens = detectSelfPenetrations(caps);
    expect(pens).toHaveLength(1);
    expect(pens[0].depthM).toBeCloseTo(0.05, 5);
    expect(pens[0].severity).toBe("fail");
  });

  it("omits the pair entirely when depth is below the warn threshold (allowed contact)", () => {
    const caps = [
      makeCapsule("chest", 0, 0, 0, 0, 0, 0, SELF_PENETRATION.radiusM.chest),
      // depth = 0.185 - dist = 0.005 になるよう dist=0.18
      makeCapsule("calf:L", 0.18, 0, 0, 0.18, 0, 0, SELF_PENETRATION.radiusM.calf),
    ];
    expect(detectSelfPenetrations(caps)).toHaveLength(0);
  });
});

describe("#128 ケース 4: perPairToleranceM.overrides の優先適用", () => {
  it("uses override tolerances instead of defaults for thigh:L × thigh:R", () => {
    const caps = [
      makeCapsule("thigh:L", 0, 0, 0, 0, 0, 0, SELF_PENETRATION.radiusM.thigh),
      // 半径和 0.14、depth = 0.14 - dist = 0.10 になるよう dist=0.04
      // default failDefault(0.03) なら fail になるはずの深さだが、
      // override fail=0.16 が優先されれば warn のまま
      makeCapsule("thigh:R", 0.04, 0, 0, 0.04, 0, 0, SELF_PENETRATION.radiusM.thigh),
    ];
    const pens = detectSelfPenetrations(caps);
    expect(pens).toHaveLength(1);
    expect(pens[0].depthM).toBeCloseTo(0.1, 5);
    expect(pens[0].severity).toBe("warn");
  });
});

describe("#128 ケース 5: pass 判定は fail severity のみに反応する", () => {
  it("isPenetrationPass returns true when only warn-severity penetrations exist", () => {
    const penetrations: Penetration[] = [
      { a: "chest", b: "foreArm:L", depthM: 0.03, severity: "warn" },
      { a: "hand:L", b: "hand:R", depthM: 0.05, severity: "warn" },
    ];
    expect(isPenetrationPass(penetrations)).toBe(true);
  });

  it("isPenetrationPass returns false when at least one fail-severity penetration exists", () => {
    const penetrations: Penetration[] = [
      { a: "chest", b: "foreArm:L", depthM: 0.03, severity: "warn" },
      { a: "thigh:L", b: "calf:R", depthM: 0.07, severity: "fail" },
    ];
    expect(isPenetrationPass(penetrations)).toBe(false);
  });
});
