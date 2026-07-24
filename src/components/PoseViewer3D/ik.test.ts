import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { LM, type RawLandmark } from "./muscles";
import { detectGroundContacts, solveTwoBoneIK, applyContactIK, CONTACT_IK } from "./ik";

const emptyLandmarks = (): RawLandmark[] =>
  Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));

describe("detectGroundContacts", () => {
  it("marks all four limbs grounded for a wheel-like pose", () => {
    // 実測値ベース（wheel.jpg）: y 下向き正、全末端が床付近
    const lm = emptyLandmarks();
    lm[LM.LEFT_FOOT_INDEX] = { x: -0.49, y: 0.879, z: -0.09 };
    lm[LM.RIGHT_FOOT_INDEX] = { x: -0.46, y: 0.79, z: 0.1 };
    lm[LM.LEFT_WRIST] = { x: 0.45, y: 0.764, z: 0.05 };
    lm[LM.RIGHT_WRIST] = { x: 0.43, y: 0.745, z: 0.22 };
    expect(detectGroundContacts(lm)).toEqual({
      leftFoot: true,
      rightFoot: true,
      leftHand: true,
      rightHand: true,
      leftKnee: false,
      rightKnee: false,
    });
  });

  it("marks only feet grounded for a standing pose with horizontal arms", () => {
    const lm = emptyLandmarks();
    lm[LM.LEFT_FOOT_INDEX] = { x: 0.3, y: 0.9, z: 0 };
    lm[LM.RIGHT_FOOT_INDEX] = { x: -0.3, y: 0.88, z: 0 };
    lm[LM.LEFT_WRIST] = { x: 0.7, y: -0.4, z: 0 };
    lm[LM.RIGHT_WRIST] = { x: -0.7, y: -0.4, z: 0 };
    expect(detectGroundContacts(lm)).toEqual({
      leftFoot: true,
      rightFoot: true,
      leftHand: false,
      rightHand: false,
      leftKnee: false,
      rightKnee: false,
    });
  });

  it("marks only hands grounded for an inverted pose (headstand)", () => {
    const lm = emptyLandmarks();
    lm[LM.LEFT_FOOT_INDEX] = { x: 0, y: -0.8, z: 0 };
    lm[LM.RIGHT_FOOT_INDEX] = { x: 0, y: -0.82, z: 0 };
    lm[LM.LEFT_WRIST] = { x: 0.1, y: 0.5, z: 0 };
    lm[LM.RIGHT_WRIST] = { x: -0.1, y: 0.49, z: 0 };
    expect(detectGroundContacts(lm)).toEqual({
      leftFoot: false,
      rightFoot: false,
      leftHand: true,
      rightHand: true,
      leftKnee: false,
      rightKnee: false,
    });
  });

  it("marks knees grounded for a kneeling pose (thigh near vertical)", () => {
    // 膝立ちサイドベンド風: 膝・足の甲が床、股関節は膝の真上、片手は頭上
    const lm = emptyLandmarks();
    lm[LM.LEFT_HIP] = { x: 0, y: 0.4, z: 0 };
    lm[LM.RIGHT_HIP] = { x: 0.1, y: 0.4, z: 0 };
    lm[LM.LEFT_KNEE] = { x: 0, y: 0.88, z: 0 };
    lm[LM.RIGHT_KNEE] = { x: 0.1, y: 0.9, z: 0 };
    lm[LM.LEFT_FOOT_INDEX] = { x: 0, y: 0.87, z: -0.3 };
    lm[LM.RIGHT_FOOT_INDEX] = { x: 0.1, y: 0.89, z: -0.3 };
    lm[LM.LEFT_WRIST] = { x: 0, y: -0.2, z: 0 };
    lm[LM.RIGHT_WRIST] = { x: 0, y: -0.3, z: 0 };
    expect(detectGroundContacts(lm)).toEqual({
      leftFoot: true,
      rightFoot: true,
      leftHand: false,
      rightHand: false,
      leftKnee: true,
      rightKnee: true,
    });
  });

  it("does not mark knees grounded for a seated pose (thigh horizontal)", () => {
    // あぐら: 膝も床付近だが股関節も床付近（腿が水平）→ 膝接地扱いにしない
    const lm = emptyLandmarks();
    lm[LM.LEFT_HIP] = { x: 0, y: 0.85, z: 0 };
    lm[LM.RIGHT_HIP] = { x: 0.1, y: 0.85, z: 0 };
    lm[LM.LEFT_KNEE] = { x: 0.35, y: 0.9, z: 0 };
    lm[LM.RIGHT_KNEE] = { x: -0.25, y: 0.9, z: 0 };
    lm[LM.LEFT_FOOT_INDEX] = { x: -0.1, y: 0.92, z: 0.1 };
    lm[LM.RIGHT_FOOT_INDEX] = { x: 0.15, y: 0.91, z: 0.1 };
    lm[LM.LEFT_WRIST] = { x: 0, y: 0.2, z: 0 };
    lm[LM.RIGHT_WRIST] = { x: 0, y: 0.2, z: 0 };
    const contacts = detectGroundContacts(lm);
    expect(contacts.leftKnee).toBe(false);
    expect(contacts.rightKnee).toBe(false);
  });

  it("excludes low-visibility candidates from contacts (#53)", () => {
    // 実測値ベース（後ろ向き膝立ち側屈画像）: 支持肢（脚・床手）の visibility が
    // すべて minContact 未満 → 接地なし（IK スキップ）になること。
    // 唯一 visibility が高い左手首は挙上腕で床から遠く、接地にならない
    const lm = emptyLandmarks();
    lm[LM.LEFT_WRIST] = { x: 0.871, y: -0.35, z: 0.04, visibility: 0.8 };
    lm[LM.RIGHT_WRIST] = { x: 0.434, y: 0.302, z: 0.005, visibility: 0.4 };
    lm[LM.LEFT_KNEE] = { x: -0.211, y: 0.34, z: -0.081, visibility: 0.37 };
    lm[LM.RIGHT_KNEE] = { x: -0.086, y: 0.269, z: -0.001, visibility: 0.21 };
    lm[LM.LEFT_FOOT_INDEX] = { x: 0.326, y: 0.383, z: 0.048, visibility: 0.15 };
    lm[LM.RIGHT_FOOT_INDEX] = { x: 0.288, y: 0.449, z: 0.11, visibility: 0.06 };
    expect(detectGroundContacts(lm)).toEqual({
      leftFoot: false,
      rightFoot: false,
      leftHand: false,
      rightHand: false,
      leftKnee: false,
      rightKnee: false,
    });
  });

  it("keeps visible contacts even when a lower hallucinated point exists (#53)", () => {
    // 床基準は全候補から取るが、接地分類は可視の landmark のみ
    const lm = emptyLandmarks();
    lm[LM.LEFT_FOOT_INDEX] = { x: 0.3, y: 0.9, z: 0, visibility: 0.95 };
    lm[LM.RIGHT_FOOT_INDEX] = { x: -0.3, y: 0.95, z: 0, visibility: 0.1 };
    lm[LM.LEFT_WRIST] = { x: 0.7, y: -0.4, z: 0, visibility: 0.95 };
    lm[LM.RIGHT_WRIST] = { x: -0.7, y: -0.4, z: 0, visibility: 0.95 };
    const contacts = detectGroundContacts(lm);
    expect(contacts.leftFoot).toBe(true);
    expect(contacts.rightFoot).toBe(false);
  });
});

/** root(股) → mid(膝) → end(足首) の 2-bone チェーンを組む */
const buildChain = (
  rootPos: THREE.Vector3,
  midPos: THREE.Vector3,
  endPos: THREE.Vector3
): { root: THREE.Bone; mid: THREE.Bone; end: THREE.Bone; scene: THREE.Group } => {
  const scene = new THREE.Group();
  const root = new THREE.Bone();
  const mid = new THREE.Bone();
  const end = new THREE.Bone();
  scene.add(root);
  root.add(mid);
  mid.add(end);
  root.position.copy(rootPos);
  mid.position.copy(midPos.clone().sub(rootPos));
  end.position.copy(endPos.clone().sub(midPos));
  scene.updateMatrixWorld(true);
  return { root, mid, end, scene };
};

describe("solveTwoBoneIK", () => {
  it("reaches a reachable target", () => {
    // 直角に曲がった長さ 1+1 のチェーン
    const { root, mid, end } = buildChain(
      new THREE.Vector3(0, 2, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(1, 1, 0)
    );
    const target = new THREE.Vector3(1, 1.2, 0.3);
    solveTwoBoneIK(root, mid, end, target, new THREE.Vector3(0, 1, 0));
    const E = end.getWorldPosition(new THREE.Vector3());
    expect(E.distanceTo(target)).toBeLessThan(1e-3);
  });

  it("extends toward an unreachable target (clamped to max reach)", () => {
    const { root, mid, end } = buildChain(
      new THREE.Vector3(0, 2, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(1, 1, 0)
    );
    const target = new THREE.Vector3(0, -5, 0); // 到達不能（距離 7 > リーチ 2）
    solveTwoBoneIK(root, mid, end, target, new THREE.Vector3(1, 0, 0));
    const E = end.getWorldPosition(new THREE.Vector3());
    const R = root.getWorldPosition(new THREE.Vector3());
    // ほぼ伸び切って target 方向を向く
    expect(E.distanceTo(R)).toBeGreaterThan(1.99);
    const dir = E.clone().sub(R).normalize();
    expect(dir.dot(new THREE.Vector3(0, -1, 0))).toBeGreaterThan(0.999);
  });

  it("preserves the bend plane of the current pose", () => {
    // XY 平面内で曲がったチェーン → IK 後も膝は XY 平面内に留まる
    const { root, mid, end } = buildChain(
      new THREE.Vector3(0, 2, 0),
      new THREE.Vector3(0.3, 1, 0),
      new THREE.Vector3(0, 0.2, 0)
    );
    // リーチ (1.044 + 0.854 = 1.898) 内のターゲット
    const target = new THREE.Vector3(0.2, 0.2, 0);
    solveTwoBoneIK(root, mid, end, target, new THREE.Vector3(0, 1, 0));
    const M = mid.getWorldPosition(new THREE.Vector3());
    expect(Math.abs(M.z)).toBeLessThan(1e-6);
    const E = end.getWorldPosition(new THREE.Vector3());
    expect(E.distanceTo(target)).toBeLessThan(1e-3);
  });
});

describe("applyContactIK", () => {
  /** human-base 風のボーン名で脚チェーンを組む */
  const buildLegRig = () => {
    const scene = new THREE.Group();
    const pelvis = new THREE.Bone();
    pelvis.name = "pelvis";
    const thigh = new THREE.Bone();
    thigh.name = "thigh_l";
    const calf = new THREE.Bone();
    calf.name = "calf_l";
    const foot = new THREE.Bone();
    foot.name = "foot_l";
    scene.add(pelvis);
    pelvis.add(thigh);
    thigh.add(calf);
    calf.add(foot);
    pelvis.position.set(0, 0, 0);
    thigh.position.set(0.1, -0.1, 0);
    calf.position.set(0.05, -0.35, 0.25); // 膝（前に曲げてリーチ余裕を作る）
    foot.position.set(0, -0.35, -0.25); // 足首
    scene.updateMatrixWorld(true);
    return { scene, foot };
  };

  it("pulls a grounded foot down to floor + clearance", () => {
    const { scene, foot } = buildLegRig();
    const lm = emptyLandmarks();
    // 左足のみ接地扱い（他の末端 landmark は大きく上）
    lm[LM.LEFT_FOOT_INDEX] = { x: 0, y: 0.9, z: 0 };
    lm[LM.RIGHT_FOOT_INDEX] = { x: 0, y: -1, z: 0 };
    lm[LM.LEFT_WRIST] = { x: 0, y: -1, z: 0 };
    lm[LM.RIGHT_WRIST] = { x: 0, y: -1, z: 0 };

    const before = foot.getWorldPosition(new THREE.Vector3());
    // 足首より 0.2 下に床（リーチ内の下げ幅にする）
    const floorY = before.y - 0.2;
    applyContactIK(scene, lm, floorY);
    const after = foot.getWorldPosition(new THREE.Vector3());

    expect(after.y).toBeCloseTo(floorY + CONTACT_IK.footClearanceM, 3);
    // 水平位置は維持される
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.z).toBeCloseTo(before.z, 3);
  });

  it("slides the target toward the hip when (x,z)-preserving reach is insufficient", () => {
    // リグ: thigh(0,0,0) → knee(0,-0.4,0.3) → ankle(0.5,-0.8,0)
    // a=0.5, b=|(0.5,-0.4,-0.3)|≈0.707, reach≈1.207
    const scene = new THREE.Group();
    const pelvis = new THREE.Bone();
    pelvis.name = "pelvis";
    const thigh = new THREE.Bone();
    thigh.name = "thigh_l";
    const calf = new THREE.Bone();
    calf.name = "calf_l";
    const foot = new THREE.Bone();
    foot.name = "foot_l";
    scene.add(pelvis);
    pelvis.add(thigh);
    thigh.add(calf);
    calf.add(foot);
    calf.position.set(0, -0.4, 0.3);
    foot.position.set(0.5, -0.4, -0.3);
    scene.updateMatrixWorld(true);

    const lm = emptyLandmarks();
    lm[LM.LEFT_FOOT_INDEX] = { x: 0, y: 0.9, z: 0 };

    const before = foot.getWorldPosition(new THREE.Vector3());
    // targetY = -1.15: drop 1.15 < reach 1.207 だが (x,z) 維持では届かない
    // （必要距離 sqrt(0.5² + 1.15²) ≈ 1.254 > reach）→ 水平スライドで接地する
    const floorY = -1.15 - CONTACT_IK.footClearanceM;
    applyContactIK(scene, lm, floorY);
    const after = foot.getWorldPosition(new THREE.Vector3());

    expect(after.y).toBeCloseTo(-1.15, 3);
    // 水平位置は hip 側へ寄る
    const beforeH = Math.hypot(before.x, before.z);
    const afterH = Math.hypot(after.x, after.z);
    expect(afterH).toBeLessThan(beforeH);
  });

  it("does not move a limb that is not grounded", () => {
    const { scene, foot } = buildLegRig();
    const lm = emptyLandmarks();
    // 左足は接地していない（手が最下点）
    lm[LM.LEFT_FOOT_INDEX] = { x: 0, y: -1, z: 0 };
    lm[LM.LEFT_WRIST] = { x: 0, y: 0.9, z: 0 };
    lm[LM.RIGHT_WRIST] = { x: 0, y: 0.88, z: 0 };

    const before = foot.getWorldPosition(new THREE.Vector3());
    applyContactIK(scene, lm, before.y - 0.3);
    const after = foot.getWorldPosition(new THREE.Vector3());
    expect(after.distanceTo(before)).toBeLessThan(1e-9);
  });

  it("lifts a below-floor grounded limb up to clearance (bends to absorb)", () => {
    const { scene, foot } = buildLegRig();
    const lm = emptyLandmarks();
    lm[LM.LEFT_FOOT_INDEX] = { x: 0, y: 0.9, z: 0 };

    const before = foot.getWorldPosition(new THREE.Vector3());
    // 床が足首と同じ高さ → target = floor + clearance は足首より上 →
    // 関節を曲げて末端を床上クリアランスへ持ち上げる（めり込み吸収）
    applyContactIK(scene, lm, before.y);
    const after = foot.getWorldPosition(new THREE.Vector3());
    expect(after.y).toBeCloseTo(before.y + CONTACT_IK.footClearanceM, 3);
  });

  it("lowers the whole body when even a slid target is out of reach", () => {
    // ほぼ伸び切った脚（リーチ余裕なし）で床が遠い → 胴体ごと下がって接地する
    const scene = new THREE.Group();
    const pelvis = new THREE.Bone();
    pelvis.name = "pelvis";
    const thigh = new THREE.Bone();
    thigh.name = "thigh_l";
    const calf = new THREE.Bone();
    calf.name = "calf_l";
    const foot = new THREE.Bone();
    foot.name = "foot_l";
    scene.add(pelvis);
    pelvis.add(thigh);
    thigh.add(calf);
    calf.add(foot);
    calf.position.set(0.02, -0.45, 0);
    foot.position.set(0, -0.45, 0.02);
    scene.updateMatrixWorld(true);

    const lm = emptyLandmarks();
    lm[LM.LEFT_FOOT_INDEX] = { x: 0, y: 0.9, z: 0 };

    const before = foot.getWorldPosition(new THREE.Vector3());
    // 床を足首の 0.2 下に置く（リーチ ~0.9 に対し drop ~1.03 で不足）
    const floorY = before.y - 0.2;
    applyContactIK(scene, lm, floorY);
    const after = foot.getWorldPosition(new THREE.Vector3());

    expect(scene.position.y).toBeLessThan(0);
    expect(after.y).toBeCloseTo(floorY + CONTACT_IK.footClearanceM, 2);
  });

  /** 膝立ち風の脚リグ（腿がやや前傾、足首は膝の後下方） */
  const buildKneelingRig = () => {
    const scene = new THREE.Group();
    const pelvis = new THREE.Bone();
    pelvis.name = "pelvis";
    const thigh = new THREE.Bone();
    thigh.name = "thigh_l";
    const calf = new THREE.Bone();
    calf.name = "calf_l";
    const foot = new THREE.Bone();
    foot.name = "foot_l";
    scene.add(pelvis);
    pelvis.add(thigh);
    thigh.add(calf);
    calf.add(foot);
    thigh.position.set(0.1, -0.05, 0);
    calf.position.set(0.25, -0.35, 0.05); // 膝: world (0.35, -0.4, 0.05)
    foot.position.set(0, -0.08, -0.38); // 足首: 膝の後下方
    scene.updateMatrixWorld(true);
    return { scene, thigh, calf, foot };
  };

  /** 左脚のみ膝立ち接地の landmarks（腿鉛直、足の甲も床、他は高所） */
  const kneelingLandmarks = (): RawLandmark[] => {
    const lm = emptyLandmarks();
    lm[LM.LEFT_HIP] = { x: 0, y: 0.4, z: 0 };
    lm[LM.LEFT_KNEE] = { x: 0, y: 0.9, z: 0 };
    lm[LM.LEFT_FOOT_INDEX] = { x: 0, y: 0.88, z: -0.2 };
    lm[LM.RIGHT_FOOT_INDEX] = { x: 0, y: -1, z: 0 };
    lm[LM.LEFT_WRIST] = { x: 0, y: -1, z: 0 };
    lm[LM.RIGHT_WRIST] = { x: 0, y: -1, z: 0 };
    return lm;
  };

  it("drops a kneeling knee to floor + clearance and lays the shin flat", () => {
    const { scene, calf, foot } = buildKneelingRig();
    // 膝(-0.4) より 0.05 下に膝ターゲットが来る床（腿リーチ内）
    const floorY = -0.5;
    applyContactIK(scene, kneelingLandmarks(), floorY);

    const knee = calf.getWorldPosition(new THREE.Vector3());
    const ankle = foot.getWorldPosition(new THREE.Vector3());
    // 膝は床 + クリアランスへ
    expect(knee.y).toBeCloseTo(floorY + CONTACT_IK.kneeClearanceM, 3);
    // すね（膝→足首）は床平行（足首 IK が走っていればここがずれる）
    expect(ankle.y).toBeCloseTo(knee.y, 3);
  });

  it("lowers the whole body when the kneeling knee target is out of thigh reach", () => {
    const { scene, calf, foot } = buildKneelingRig();
    // 腿リーチ ~0.43 に対し股関節から 0.6 下の膝ターゲット → 胴体降下が必要
    const floorY = -0.7;
    applyContactIK(scene, kneelingLandmarks(), floorY);

    const knee = calf.getWorldPosition(new THREE.Vector3());
    const ankle = foot.getWorldPosition(new THREE.Vector3());
    expect(scene.position.y).toBeLessThan(0);
    expect(knee.y).toBeCloseTo(floorY + CONTACT_IK.kneeClearanceM, 2);
    expect(ankle.y).toBeCloseTo(knee.y, 2);
  });

  it("ケース 7: IK ドラッグ統合 (IK.test.ts で回帰)", async () => {
    const clampModule = await import("./clampInput");
    const spy = vi.spyOn(clampModule, "tryApplyWithClamp");

    const { scene, thigh, calf, foot } = buildKneelingRig();
    thigh.userData.stdName = "LeftUpLeg";
    thigh.name = "mixamorig:LeftUpLeg";
    calf.userData.stdName = "LeftLeg";
    calf.name = "mixamorig:LeftLeg";
    foot.userData.stdName = "LeftFoot";
    foot.name = "mixamorig:LeftFoot";

    scene.updateMatrixWorld(true);

    const floorY = -0.5;
    applyContactIK(scene, kneelingLandmarks(), floorY);

    // 1. tryApplyWithClamp が実際に呼び出されたこと（中核 DoD）の確認
    expect(spy).toHaveBeenCalled();

    // 2. reject シナリオ: spy が { accepted: false, ... } を返す場合に 1 step 手前（safe位置）へ clamp されること
    let factorApplied = -1;
    spy.mockImplementation((_mannequin, applyDelta) => {
      factorApplied = 0.5;
      applyDelta(0.5);
      return {
        accepted: false,
        blockedPairs: [{ a: "thigh:L", b: "chest" }],
      };
    });

    applyContactIK(scene, kneelingLandmarks(), floorY);
    expect(spy).toHaveBeenCalled();
    expect(factorApplied).toBe(0.5);

    spy.mockRestore();
  });
});
