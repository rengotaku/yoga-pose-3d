import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { tryApplyWithClamp } from "./clampInput";
import { detectSelfPenetrations, buildBodyCapsules } from "./poseValidity";

/**
 * テスト用マネキン（ボーンリグ）の作成ヘルパー。
 * LeftArm / LeftForeArm と RightArm / RightForeArm を含むリグを生成する。
 * stdName を設定して buildBodyCapsules が正しく認識できるようにする。
 */
function createTestMannequin() {
  const root = new THREE.Group();

  const spine1 = new THREE.Bone();
  spine1.name = "mixamorig:Spine1";
  spine1.userData.stdName = "Spine1";
  root.add(spine1);

  const neck = new THREE.Bone();
  neck.name = "mixamorig:Neck";
  neck.userData.stdName = "Neck";
  neck.position.set(0, 0.3, 0);
  spine1.add(neck);

  // LeftArm -> LeftForeArm -> LeftHand
  const leftArm = new THREE.Bone();
  leftArm.name = "mixamorig:LeftArm";
  leftArm.userData.stdName = "LeftArm";
  leftArm.position.set(-0.25, 0.15, 0);
  spine1.add(leftArm);

  const leftForeArm = new THREE.Bone();
  leftForeArm.name = "mixamorig:LeftForeArm";
  leftForeArm.userData.stdName = "LeftForeArm";
  leftForeArm.position.set(-0.2, 0, 0);
  leftArm.add(leftForeArm);

  const leftHand = new THREE.Bone();
  leftHand.name = "mixamorig:LeftHand";
  leftHand.userData.stdName = "LeftHand";
  leftHand.position.set(-0.2, 0, 0);
  leftForeArm.add(leftHand);

  // RightArm -> RightForeArm -> RightHand
  const rightArm = new THREE.Bone();
  rightArm.name = "mixamorig:RightArm";
  rightArm.userData.stdName = "RightArm";
  rightArm.position.set(0.25, 0.15, 0);
  spine1.add(rightArm);

  const rightForeArm = new THREE.Bone();
  rightForeArm.name = "mixamorig:RightForeArm";
  rightForeArm.userData.stdName = "RightForeArm";
  rightForeArm.position.set(0.2, 0, 0);
  rightArm.add(rightForeArm);

  const rightHand = new THREE.Bone();
  rightHand.name = "mixamorig:RightHand";
  rightHand.userData.stdName = "RightHand";
  rightHand.position.set(0.2, 0, 0);
  rightForeArm.add(rightHand);

  root.updateMatrixWorld(true);
  return { root, leftArm, leftForeArm, rightArm, rightForeArm };
}

describe("clampInput - 事前設計ケース", () => {
  it("ケース 1: clamp の accept パス (fail 件数増えない)", () => {
    const { root, leftArm } = createTestMannequin();
    const initialRot = leftArm.quaternion.clone();
    // 小さい回転 (貫通しない)
    const targetRot = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      0.05
    );

    const result = tryApplyWithClamp(root, (factor) => {
      leftArm.quaternion.copy(initialRot).slerp(targetRot, factor);
    });

    expect(result.accepted).toBe(true);
    expect(result.blockedPairs).toHaveLength(0);
    // mannequin の pose が applyDelta 適用後の状態になっていること
    expect(leftArm.quaternion.x).toBeCloseTo(targetRot.x, 3);
    expect(leftArm.quaternion.y).toBeCloseTo(targetRot.y, 3);
    expect(leftArm.quaternion.z).toBeCloseTo(targetRot.z, 3);
    expect(leftArm.quaternion.w).toBeCloseTo(targetRot.w, 3);
  });

  it("ケース 2: clamp の reject パス (fail 件数増える)", () => {
    const { root, leftArm } = createTestMannequin();
    const initialLeftRot = leftArm.quaternion.clone();

    // leftArm を Z 軸周りに Math.PI 回転させて foreArm:L を chest に深くめり込ませる
    const targetLeftRot = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      Math.PI
    );

    const result = tryApplyWithClamp(root, (factor) => {
      leftArm.quaternion.copy(initialLeftRot).slerp(targetLeftRot, factor);
    });

    expect(result.accepted).toBe(false);
    expect(result.blockedPairs.length).toBeGreaterThanOrEqual(1);

    // clamp 後の pose は safe な位置（貫通しない最大ファクター）であること
    root.updateMatrixWorld(true);
    const postFails = detectSelfPenetrations(buildBodyCapsules(root)).filter(
      (p) => p.severity === "fail"
    );
    expect(postFails.length).toBe(0);

    // 完全な元位置 (factor=0) でも完全なターゲット (factor=1) でもなく、その間の位置
    expect(leftArm.quaternion.equals(initialLeftRot)).toBe(false);
    expect(leftArm.quaternion.equals(targetLeftRot)).toBe(false);
  });

  it("ケース 3: warn severity では clamp が発火しない", () => {
    const { root, leftArm } = createTestMannequin();
    const initialLeftRot = leftArm.quaternion.clone();

    // 浅い回転角度で、depth が warn 領域 (0.02m < depth <= 0.06m) に収まる回転にする
    // 例: Math.PI * 0.45 程度
    const targetLeftRot = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      Math.PI * 0.45
    );

    const result = tryApplyWithClamp(root, (factor) => {
      leftArm.quaternion.copy(initialLeftRot).slerp(targetLeftRot, factor);
    });

    expect(result.accepted).toBe(true);
    expect(result.blockedPairs).toHaveLength(0);
  });

  it("ケース 4: 既に fail がある pose での挙動 (fail 件数の差分判定)", () => {
    const { root, leftArm, rightArm } = createTestMannequin();

    // 初期状態で既に leftArm の回転により 1 件の fail が発生している状態
    leftArm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
    root.updateMatrixWorld(true);

    // 既存 fail の件数を調整 (Math.PI では clampInput の二分探索と同じく fail が発生)
    // 直接 rotate して failCount > 0 にする
    const initialFails = detectSelfPenetrations(buildBodyCapsules(root)).filter(
      (p) => p.severity === "fail"
    );
    const baseCount = initialFails.length;
    expect(baseCount).toBeGreaterThan(0); // 前提: 既存 fail が存在する

    const startRotRight = rightArm.quaternion.clone();

    // パターンA: fail 件数が増えない変化 (同数: rightArm を外側に動かす)
    const harmlessDeltaRight = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      -0.1
    );
    const resultA = tryApplyWithClamp(root, (factor) => {
      rightArm.quaternion.copy(startRotRight).slerp(harmlessDeltaRight, factor);
    });
    expect(resultA.accepted).toBe(true); // 件数増えないので OK

    // パターンB: rightArm も Math.PI 回転させて chest にめり込ませて fail 件数を増やす
    const harmfulDeltaRight = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      -Math.PI
    );
    const resultB = tryApplyWithClamp(root, (factor) => {
      rightArm.quaternion.copy(startRotRight).slerp(harmfulDeltaRight, factor);
    });
    expect(resultB.accepted).toBe(false); // 件数増えたら NG
  });

  it("ケース 5: 二分探索の収束 (境界値)", () => {
    const { root, leftArm } = createTestMannequin();
    const initialRot = leftArm.quaternion.clone();
    const targetRot = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      Math.PI
    );

    const appliedFactors: number[] = [];
    const result = tryApplyWithClamp(root, (factor) => {
      appliedFactors.push(factor);
      leftArm.quaternion.copy(initialRot).slerp(targetRot, factor);
    });

    expect(result.accepted).toBe(false);
    const finalFactor = appliedFactors[appliedFactors.length - 1];
    expect(finalFactor).toBeGreaterThan(0.0);
    expect(finalFactor).toBeLessThan(1.0);
  });

  it("ケース 8: パフォーマンス (60fps 予算)", () => {
    const { root, leftArm } = createTestMannequin();
    const initialRot = leftArm.quaternion.clone();
    const targetRot = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      Math.PI * 0.5
    );

    const start = performance.now();
    const iterations = 100;
    for (let i = 0; i < iterations; i++) {
      tryApplyWithClamp(root, (factor) => {
        leftArm.quaternion.copy(initialRot).slerp(targetRot, factor * (i / iterations));
      });
    }
    const elapsed = performance.now() - start;
    const avgMs = elapsed / iterations;

    expect(avgMs).toBeLessThanOrEqual(16); // 60fps 予算 (16ms 以下)
  });
});
