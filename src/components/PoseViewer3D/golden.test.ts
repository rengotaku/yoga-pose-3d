import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  applyGoldenRotations,
  diagnosePose,
  exportBoneChildDirs,
  exportWorldRotations,
  quaternionAngleDeg,
  scorePose,
  SCORE_BONE_WEIGHTS,
  type GoldenPose,
  type QuatTuple,
} from "./golden";

/**
 * e2e/golden/<name>.json を実データとして読み込み GoldenPose として扱う（#104）。
 * Vite の import.meta.glob 経由で読む（node:fs は tsconfig.app.json の
 * "types" に "node" が含まれず tsc -b がエラーになるため使わない）。
 */
const GOLDEN_MODULES = import.meta.glob<{ default: GoldenPose }>(
  "../../../e2e/golden/{tabletop,cross-seat,kneel-sidebend}.json",
  { eager: true }
);
const loadGoldenJson = (name: string): GoldenPose => {
  const entry = Object.entries(GOLDEN_MODULES).find(([path]) =>
    path.endsWith(`/${name}.json`)
  );
  if (!entry) throw new Error(`golden json not found: ${name}`);
  return entry[1].default;
};

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

  it("splits a swing-only offset into swing/twist subscores when childDirs is given (#102)", () => {
    const golden = allIdentity();
    const actual = allIdentity();
    // Spine の子方向 (0,1,0) に対して垂直軸まわりに 90° = 純粋 swing、twist は 0°
    const swing90 = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      Math.PI / 2
    );
    actual.Spine = [swing90.x, swing90.y, swing90.z, swing90.w];
    const childDirs: Record<string, [number, number, number]> = { Spine: [0, 1, 0] };

    const score = scorePose(golden, actual, childDirs);

    expect(score.total).toBeLessThan(100);
    expect(score.joints.Spine.swingDeg!).toBeCloseTo(90, 1);
    expect(score.joints.Spine.twistDeg!).toBeCloseTo(0, 1);
    expect(score.summary.swingAvg).toBeCloseTo(0, 6);
    expect(score.summary.twistAvg).toBeCloseTo(1, 6);
    expect(score.summary.swingScored).toBe(1);
    expect(score.summary.swingWeight).toBe(SCORE_BONE_WEIGHTS.Spine);
    expect(score.summary.twistScored).toBe(1);
  });

  it("leaves swing/twist null when childDirs is not provided", () => {
    const golden = allIdentity();
    const actual = allIdentity();
    const pitch90 = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(Math.PI / 2, 0, 0)
    );
    actual.Hips = [pitch90.x, pitch90.y, pitch90.z, pitch90.w];

    const score = scorePose(golden, actual);

    expect(score.joints.Hips.swingDeg).toBeNull();
    expect(score.joints.Hips.twistDeg).toBeNull();
    expect(score.joints.Hips.swingScore).toBeNull();
    expect(score.joints.Hips.twistScore).toBeNull();
    expect(score.summary.swingAvg).toBeNull();
    expect(score.summary.twistAvg).toBeNull();
    expect(score.summary.swingScored).toBe(0);
    expect(score.summary.swingWeight).toBe(0);
    expect(score.summary.twistScored).toBe(0);
    expect(score.summary.twistWeight).toBe(0);
  });

  it("reports coverage ratio as scored / (scored + missing)", () => {
    const golden = allIdentity();
    const actual = allIdentity();
    const allNames = Object.keys(SCORE_BONE_WEIGHTS);
    expect(allNames.length).toBe(15);
    // 15 関節中 7 関節を欠損させ、8 関節だけスコア対象に残す
    for (const name of allNames.slice(8)) {
      delete actual[name];
    }

    const score = scorePose(golden, actual);

    expect(score.summary.coverage.scored).toBe(8);
    expect(score.summary.coverage.missing).toBe(7);
    expect(score.summary.coverage.ratio).toBeCloseTo(8 / 15, 6);
  });

  it("returns identical p10/median/min when every joint scores the same", () => {
    const score = scorePose(allIdentity(), allIdentity());
    expect(score.stats.p10).toBeCloseTo(1, 6);
    expect(score.stats.median).toBeCloseTo(1, 6);
    expect(score.stats.min).toBeCloseTo(1, 6);
  });
});

describe("exportBoneChildDirs", () => {
  it("returns normalized child directions and skips childless bones", () => {
    const { root, spine01, upperarmL } = buildRig();
    spine01.position.set(0, 2, 0);
    upperarmL.position.set(0, 2, 0);
    root.updateMatrixWorld(true);
    const dirs = exportBoneChildDirs(root);
    // Hips(pelvis) の子 = spine_01 (0,2,0) → 正規化 (0,1,0)
    expect(dirs.Hips).toBeDefined();
    expect(dirs.Hips[1]).toBeCloseTo(1, 5);
    // upperarm_l は子を持たないので含まれない
    expect(dirs.LeftArm).toBeUndefined();
  });
});

describe("diagnosePose", () => {
  const CHILD_DIRS: Record<string, [number, number, number]> = {
    Spine: [0, 1, 0],
  };

  it("attributes a rotation about the bone axis to twist", () => {
    const twist = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      (40 * Math.PI) / 180
    );
    const diag = diagnosePose(
      { Hips: IDENTITY, Spine: IDENTITY },
      { Hips: IDENTITY, Spine: [twist.x, twist.y, twist.z, twist.w] },
      CHILD_DIRS
    );
    expect(diag.Spine.angleDeg).toBeCloseTo(40, 1);
    expect(diag.Spine.swingDeg!).toBeCloseTo(0, 1);
    expect(diag.Spine.twistDeg!).toBeCloseTo(40, 1);
  });

  it("attributes a rotation perpendicular to the bone axis to swing", () => {
    const swing = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      (30 * Math.PI) / 180
    );
    const diag = diagnosePose(
      { Hips: IDENTITY, Spine: IDENTITY },
      { Hips: IDENTITY, Spine: [swing.x, swing.y, swing.z, swing.w] },
      CHILD_DIRS
    );
    expect(diag.Spine.angleDeg).toBeCloseTo(30, 1);
    expect(diag.Spine.swingDeg!).toBeCloseTo(30, 1);
    expect(diag.Spine.twistDeg!).toBeCloseTo(0, 1);
  });

  it("reports null swing/twist for bones without a child dir", () => {
    const diag = diagnosePose(
      { Hips: IDENTITY, Spine: IDENTITY },
      { Hips: IDENTITY, Spine: IDENTITY },
      {}
    );
    expect(diag.Spine.angleDeg).toBeCloseTo(0, 5);
    expect(diag.Spine.swingDeg).toBeNull();
    expect(diag.Spine.twistDeg).toBeNull();
  });
});

describe("GoldenPose.tier (#104)", () => {
  it("is optional and undefined when omitted", () => {
    const golden: GoldenPose = { pose: "t", rotations: {} };
    expect(golden.tier).toBeUndefined();
  });

  it("accepts both dev and holdout values", () => {
    const dev: GoldenPose = { pose: "t", rotations: {}, tier: "dev" };
    const holdout: GoldenPose = { pose: "t", rotations: {}, tier: "holdout" };
    expect(dev.tier).toBe("dev");
    expect(holdout.tier).toBe("holdout");
  });

  it.each(["tabletop", "cross-seat", "kneel-sidebend"])(
    "marks the existing golden %s as tier dev",
    (name) => {
      const golden = loadGoldenJson(name);
      expect(golden.tier).toBe("dev");
    }
  );
});
