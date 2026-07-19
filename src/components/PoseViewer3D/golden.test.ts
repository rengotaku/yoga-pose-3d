import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  applyGoldenRotations,
  exportWorldRotations,
  quaternionAngleDeg,
  scorePose,
  SCORE_BONE_WEIGHTS,
  type GoldenPose,
  type QuatTuple,
} from "./golden";

/** UE 系命名の最小スケルトン（実 glb と同じ名前解決経路を通す） */
const buildRig = () => {
  const root = new THREE.Group();
  const pelvis = new THREE.Bone();
  pelvis.name = "pelvis";
  const spine01 = new THREE.Bone();
  spine01.name = "spine_01";
  const upperarmL = new THREE.Bone();
  upperarmL.name = "upperarm_l";
  const initial = new Map<string, THREE.Quaternion>();

  pelvis.add(spine01);
  spine01.add(upperarmL);
  root.add(pelvis);
  for (const b of [pelvis, spine01, upperarmL]) {
    initial.set(b.name, b.quaternion.clone());
  }
  return { root, pelvis, spine01, upperarmL, initial };
};

const IDENTITY: QuatTuple = [0, 0, 0, 1];

describe("applyGoldenRotations", () => {
  it("applies euler degrees relative to bind pose and resets previous pose", () => {
    const { root, upperarmL, initial } = buildRig();
    // 事前に別のポーズが乗っていてもリセットされる
    upperarmL.quaternion.setFromEuler(new THREE.Euler(1, 1, 1));

    const golden: GoldenPose = {
      pose: "t",
      rotations: { LeftArm: [0, 0, 90] },
    };
    const unresolved = applyGoldenRotations(root, initial, golden);

    expect(unresolved).toEqual([]);
    const expected = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, 0, Math.PI / 2, "XYZ")
    );
    expect(upperarmL.quaternion.angleTo(expected)).toBeLessThan(1e-6);
  });

  it("returns unresolved bone names without throwing", () => {
    const { root, initial } = buildRig();
    const golden: GoldenPose = {
      pose: "t",
      rotations: { RightArm: [10, 0, 0], Hips: [5, 0, 0] },
    };
    // RightArm(upperarm_r) はこのリグに存在しない
    expect(applyGoldenRotations(root, initial, golden)).toEqual(["RightArm"]);
  });
});

describe("exportWorldRotations", () => {
  it("returns world rotations (parent chain applied) for resolvable score bones", () => {
    const { root, pelvis } = buildRig();
    pelvis.quaternion.setFromEuler(new THREE.Euler(0, Math.PI / 2, 0));

    const out = exportWorldRotations(root);
    expect(Object.keys(out).sort()).toEqual(["Hips", "LeftArm", "Spine"]);
    // 子ボーン（ローカル無回転）にも親の world 回転が乗る
    expect(quaternionAngleDeg(out.Spine, out.Hips)).toBeLessThan(1e-4);
    expect(quaternionAngleDeg(out.Hips, IDENTITY)).toBeCloseTo(90, 3);
  });
});

describe("quaternionAngleDeg", () => {
  it("is 0 for identical and double-cover equivalent quaternions", () => {
    const q: QuatTuple = [0.5, 0.5, 0.5, 0.5];
    const negQ: QuatTuple = [-0.5, -0.5, -0.5, -0.5];
    expect(quaternionAngleDeg(q, q)).toBeCloseTo(0, 6);
    expect(quaternionAngleDeg(q, negQ)).toBeCloseTo(0, 6);
  });

  it("measures geodesic angle", () => {
    const rot90 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0));
    expect(
      quaternionAngleDeg(IDENTITY, [rot90.x, rot90.y, rot90.z, rot90.w])
    ).toBeCloseTo(90, 4);
  });
});

describe("scorePose", () => {
  const allIdentity = (): Record<string, QuatTuple> =>
    Object.fromEntries(
      Object.keys(SCORE_BONE_WEIGHTS).map((k) => [k, [...IDENTITY] as QuatTuple])
    );

  it("scores 100 for identical rotations", () => {
    const score = scorePose(allIdentity(), allIdentity());
    expect(score.total).toBeCloseTo(100, 6);
    expect(score.missing).toEqual([]);
  });

  it("penalizes by weight share when one joint is 90° pitched off", () => {
    // ヨーは正規化されるため、単関節ズレのテストはピッチ（X）で行う
    const golden = allIdentity();
    const actual = allIdentity();
    const pitch90 = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(Math.PI / 2, 0, 0)
    );
    actual.Hips = [pitch90.x, pitch90.y, pitch90.z, pitch90.w];

    const score = scorePose(golden, actual);
    const totalWeight = Object.values(SCORE_BONE_WEIGHTS).reduce((a, b) => a + b, 0);
    const expected = ((totalWeight - SCORE_BONE_WEIGHTS.Hips) / totalWeight) * 100;
    expect(score.total).toBeCloseTo(expected, 4);
    expect(score.joints.Hips.score).toBeCloseTo(0, 6);
  });

  it("is invariant to a global yaw difference (#76)", () => {
    const golden = allIdentity();
    const actual = allIdentity();
    const yaw = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0));
    for (const k of Object.keys(actual)) {
      actual[k] = [yaw.x, yaw.y, yaw.z, yaw.w];
    }
    const score = scorePose(golden, actual);
    expect(score.total).toBeCloseTo(100, 4);
  });

  it("still penalizes a global pitch difference (#76)", () => {
    const golden = allIdentity();
    const actual = allIdentity();
    const pitch = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
    for (const k of Object.keys(actual)) {
      actual[k] = [pitch.x, pitch.y, pitch.z, pitch.w];
    }
    const score = scorePose(golden, actual);
    expect(score.total).toBeCloseTo(0, 4);
  });

  it("lists joints missing from either side and excludes them from the average", () => {
    const golden = allIdentity();
    const actual = allIdentity();
    delete actual.LeftHand;
    const score = scorePose(golden, actual);
    expect(score.missing).toEqual(["LeftHand"]);
    expect(score.total).toBeCloseTo(100, 6);
  });
});
