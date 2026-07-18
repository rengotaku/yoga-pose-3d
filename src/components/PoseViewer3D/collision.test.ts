import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { LM, type RawLandmark } from "./muscles";
import {
  TORSO_PUSHOUT,
  closestPointOnSegment,
  computeTorsoCapsule,
  applyTorsoPushOut,
} from "./collision";

const emptyLandmarks = (): RawLandmark[] =>
  Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));

describe("closestPointOnSegment", () => {
  it("projects onto the segment interior", () => {
    const p = closestPointOnSegment(
      new THREE.Vector3(0.5, 1, 0),
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1, 0, 0)
    );
    expect(p.distanceTo(new THREE.Vector3(0.5, 0, 0))).toBeLessThan(1e-6);
  });

  it("clamps to the segment ends", () => {
    const p = closestPointOnSegment(
      new THREE.Vector3(2, 1, 0),
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1, 0, 0)
    );
    expect(p.distanceTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-6);
  });
});

/** 胴体（spine_01→neck_01）+ 左腕チェーンのボーンだけのリグ（メッシュなし） */
const buildTorsoArmRig = () => {
  const scene = new THREE.Group();
  const mk = (name: string, parent: THREE.Object3D, pos: [number, number, number]) => {
    const b = new THREE.Bone();
    b.name = name;
    parent.add(b);
    b.position.set(...pos);
    return b;
  };
  const pelvis = mk("pelvis", scene, [0, 0, 0]);
  const spine1 = mk("spine_01", pelvis, [0, 0.1, 0]);
  const spine2 = mk("spine_02", spine1, [0, 0.15, 0]);
  const spine3 = mk("spine_03", spine2, [0, 0.15, 0]);
  const neck = mk("neck_01", spine3, [0, 0.15, 0]);
  // 肩(0.2, 0.45) → 肘 → 手首。手首は胴体軸のすぐ近く（カプセル内）
  const upperarm = mk("upperarm_l", spine3, [0.2, 0.05, 0]);
  const lowerarm = mk("lowerarm_l", upperarm, [0.05, -0.22, 0.1]);
  const hand = mk("hand_l", lowerarm, [-0.22, 0.08, -0.08]);
  scene.updateMatrixWorld(true);
  return { scene, pelvis, spine1, neck, upperarm, lowerarm, hand };
};

/** 手足は接地していない（足のみ接地）landmarks */
const airborneHandsLandmarks = (): RawLandmark[] => {
  const lm = emptyLandmarks();
  lm[LM.LEFT_FOOT_INDEX] = { x: 0, y: 0.9, z: 0 };
  lm[LM.RIGHT_FOOT_INDEX] = { x: 0, y: 0.88, z: 0 };
  lm[LM.LEFT_WRIST] = { x: 0, y: -0.3, z: 0 };
  lm[LM.RIGHT_WRIST] = { x: 0, y: -0.3, z: 0 };
  return lm;
};

describe("computeTorsoCapsule", () => {
  it("builds a capsule along spine→neck with fallback radius when no mesh", () => {
    const { scene, spine1, neck } = buildTorsoArmRig();
    const capsule = computeTorsoCapsule(scene);
    expect(capsule).not.toBeNull();
    const a = spine1.getWorldPosition(new THREE.Vector3());
    const b = neck.getWorldPosition(new THREE.Vector3());
    expect(capsule!.a.distanceTo(a)).toBeLessThan(1e-6);
    expect(capsule!.b.distanceTo(b)).toBeLessThan(1e-6);
    expect(capsule!.radius).toBeCloseTo(TORSO_PUSHOUT.torsoRadiusM, 6);
  });

  it("returns null when torso bones are missing", () => {
    const scene = new THREE.Group();
    const bone = new THREE.Bone();
    bone.name = "thigh_l";
    scene.add(bone);
    scene.updateMatrixWorld(true);
    expect(computeTorsoCapsule(scene)).toBeNull();
  });
});

describe("applyTorsoPushOut", () => {
  it("pushes a hand inside the torso capsule forward to the chest surface", () => {
    const { scene, spine1, neck, hand } = buildTorsoArmRig();
    const a = spine1.getWorldPosition(new THREE.Vector3());
    const b = neck.getWorldPosition(new THREE.Vector3());
    const before = hand.getWorldPosition(new THREE.Vector3());
    const dBefore = before.distanceTo(closestPointOnSegment(before, a, b));
    expect(dBefore).toBeLessThan(TORSO_PUSHOUT.torsoRadiusM); // 前提: めり込んでいる

    applyTorsoPushOut(scene, airborneHandsLandmarks());

    // 胴体前方向（pelvis 無回転 → world +Z）の符号付き距離が表面まで出る
    const after = hand.getWorldPosition(new THREE.Vector3());
    const fAfter = after.clone().sub(closestPointOnSegment(after, a, b)).z;
    expect(fAfter).toBeGreaterThanOrEqual(
      TORSO_PUSHOUT.torsoRadiusM + TORSO_PUSHOUT.clearanceM - 5e-3
    );
  });

  it("does not move a behind-the-back hand even if inside the capsule", () => {
    const { scene, lowerarm, hand } = buildTorsoArmRig();
    // 手首を胴体背面側（-Z）のカプセル内へ
    lowerarm.position.set(0.05, -0.22, -0.1);
    hand.position.set(-0.22, 0.08, 0.02);
    scene.updateMatrixWorld(true);
    const before = hand.getWorldPosition(new THREE.Vector3());
    expect(before.z).toBeLessThan(0);

    applyTorsoPushOut(scene, airborneHandsLandmarks());

    const after = hand.getWorldPosition(new THREE.Vector3());
    expect(after.distanceTo(before)).toBeLessThan(1e-9);
  });

  it("does not move a hand that is outside the capsule", () => {
    const { scene, lowerarm, hand } = buildTorsoArmRig();
    // 手首を胴体から離れた位置へ（前腕の向きを外側へ）
    lowerarm.position.set(0.1, -0.25, 0.05);
    hand.position.set(0.2, -0.1, 0.05);
    scene.updateMatrixWorld(true);
    const before = hand.getWorldPosition(new THREE.Vector3());

    applyTorsoPushOut(scene, airborneHandsLandmarks());

    const after = hand.getWorldPosition(new THREE.Vector3());
    expect(after.distanceTo(before)).toBeLessThan(1e-9);
  });

  it("does not move a grounded hand even if inside the capsule", () => {
    const { scene, hand } = buildTorsoArmRig();
    const lm = airborneHandsLandmarks();
    lm[LM.LEFT_WRIST] = { x: 0, y: 0.89, z: 0 }; // 接地扱い
    const before = hand.getWorldPosition(new THREE.Vector3());

    applyTorsoPushOut(scene, lm);

    const after = hand.getWorldPosition(new THREE.Vector3());
    expect(after.distanceTo(before)).toBeLessThan(1e-9);
  });
});
