import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { LM, toVec, type RawLandmark } from "./muscles";
import { clampHingeJoints, JOINT_LIMITS } from "./jointLimits";

// muscles.ts の LM に未定義のインデックス（このテスト専用）
const LEFT_HEEL = 29;
const LEFT_THUMB = 21;
const RIGHT_HEEL = 30;

/**
 * 直立の骨盤・肩ラインを持つ基本骨格（33 landmark）。
 * computeHipsRotation の +Z（骨盤前方）が Three.js 空間で (0,0,1) になるよう
 * hip line = X軸, spine = Y軸 に揃えてある。
 */
const baseLandmarks = (): RawLandmark[] => {
  const lm: RawLandmark[] = Array.from({ length: 33 }, () => ({
    x: 0,
    y: 0,
    z: 0,
    visibility: 1,
  }));
  lm[LM.LEFT_HIP] = { x: 0.1, y: 0, z: 0, visibility: 1 };
  lm[LM.RIGHT_HIP] = { x: -0.1, y: 0, z: 0, visibility: 1 };
  lm[LM.LEFT_SHOULDER] = { x: 0.1, y: -0.5, z: 0, visibility: 1 };
  lm[LM.RIGHT_SHOULDER] = { x: -0.1, y: -0.5, z: 0, visibility: 1 };
  return lm;
};

/** MediaPipe生座標 → Three.js座標の点変換の逆（toVecは並進を持たない線形写像なので自己逆変換） */
const fromVec = (v: THREE.Vector3): { x: number; y: number; z: number } => ({
  x: v.x,
  y: -v.y,
  z: -v.z,
});

describe("clampHingeJoints", () => {
  it("膝が骨盤前方へ折れたフィクスチャはミラーされ、heel/foot_indexも同量移動する", () => {
    const lm = baseLandmarks();
    lm[LM.LEFT_KNEE] = { x: 0.1, y: 0.4, z: 0, visibility: 1 };
    // 足首が大腿の前方側（骨盤前方＝raw z負方向）へ折れている＝解剖学的に不可能
    lm[LM.LEFT_ANKLE] = { x: 0.1, y: 0.5, z: -0.3, visibility: 1 };
    lm[LEFT_HEEL] = { x: 0.1, y: 0.55, z: -0.32, visibility: 1 };
    lm[LM.LEFT_FOOT_INDEX] = { x: 0.15, y: 0.6, z: -0.35, visibility: 1 };

    const out = clampHingeJoints(lm);

    // ミラー後は屈曲量を保ったまま z が反転する（後方側へ）
    expect(out[LM.LEFT_ANKLE].x).toBeCloseTo(0.1, 6);
    expect(out[LM.LEFT_ANKLE].y).toBeCloseTo(0.5, 6);
    expect(out[LM.LEFT_ANKLE].z).toBeCloseTo(0.3, 6);

    expect(out[LEFT_HEEL].x).toBeCloseTo(0.1, 6);
    expect(out[LEFT_HEEL].y).toBeCloseTo(0.55, 6);
    expect(out[LEFT_HEEL].z).toBeCloseTo(0.28, 6);

    expect(out[LM.LEFT_FOOT_INDEX].x).toBeCloseTo(0.15, 6);
    expect(out[LM.LEFT_FOOT_INDEX].y).toBeCloseTo(0.6, 6);
    expect(out[LM.LEFT_FOOT_INDEX].z).toBeCloseTo(0.25, 6);
  });

  it("正常な椅子座り相当（足首が後方）は無変更", () => {
    const lm = baseLandmarks();
    lm[LM.LEFT_KNEE] = { x: 0.1, y: 0.4, z: 0, visibility: 1 };
    // 前段の「折れ」フィクスチャをミラーした後の状態（=解剖学的に正しい後方側）
    lm[LM.LEFT_ANKLE] = { x: 0.1, y: 0.5, z: 0.3, visibility: 1 };
    lm[LEFT_HEEL] = { x: 0.1, y: 0.55, z: 0.28, visibility: 1 };
    lm[LM.LEFT_FOOT_INDEX] = { x: 0.15, y: 0.6, z: 0.25, visibility: 1 };

    const out = clampHingeJoints(lm);

    expect(out[LM.LEFT_ANKLE]).toEqual(lm[LM.LEFT_ANKLE]);
    expect(out[LEFT_HEEL]).toEqual(lm[LEFT_HEEL]);
    expect(out[LM.LEFT_FOOT_INDEX]).toEqual(lm[LM.LEFT_FOOT_INDEX]);
  });

  it("屈曲170°のフィクスチャは150°にクランプされる", () => {
    const lm = baseLandmarks();
    lm[LM.LEFT_HIP] = { x: 0.1, y: 0, z: 0, visibility: 1 }; // 既存だが明示
    lm[LM.LEFT_KNEE] = { x: 0.1, y: 0.4, z: 0, visibility: 1 }; // uHat(Three) = (0,-1,0)

    const legLen = 0.4;
    const theta170 = (170 * Math.PI) / 180;
    const kneeVec = toVec(lm[LM.LEFT_KNEE]);
    // z=0固定の回転パラメータ化: w(θ) = (sinθ, -cosθ, 0) * legLen
    // → ミラーは発火せず、屈曲クランプのみを単独で検証できる
    const wAt170 = new THREE.Vector3(
      Math.sin(theta170),
      -Math.cos(theta170),
      0
    ).multiplyScalar(legLen);
    const ankleVec170 = kneeVec.clone().add(wAt170);
    lm[LM.LEFT_ANKLE] = { ...fromVec(ankleVec170), visibility: 1 };

    const out = clampHingeJoints(lm);

    const theta150 = (150 * Math.PI) / 180;
    const wAt150 = new THREE.Vector3(
      Math.sin(theta150),
      -Math.cos(theta150),
      0
    ).multiplyScalar(legLen);
    const expectedAnkleVec = kneeVec.clone().add(wAt150);
    const expectedAnkle = fromVec(expectedAnkleVec);

    expect(out[LM.LEFT_ANKLE].x).toBeCloseTo(expectedAnkle.x, 6);
    expect(out[LM.LEFT_ANKLE].y).toBeCloseTo(expectedAnkle.y, 6);
    expect(out[LM.LEFT_ANKLE].z).toBeCloseTo(expectedAnkle.z, 6);

    // クランプ後の屈曲角がちょうど maxKneeFlexionRad であること
    const uHat = new THREE.Vector3(0, -1, 0);
    const wOut = fromVecToThreeDelta(out[LM.LEFT_ANKLE], out[LM.LEFT_KNEE]);
    expect(uHat.angleTo(wOut)).toBeCloseTo(JOINT_LIMITS.maxKneeFlexionRad, 5);
  });

  it("直立(φ≈0)で微小前方ノイズがあってもdeadband内なら無変更", () => {
    const lm = baseLandmarks();
    lm[LM.LEFT_KNEE] = { x: 0.1, y: 0.4, z: 0, visibility: 1 };
    // w(Three) = (0, -0.4, 0.015): deadband(0.05)*|w|(~0.4) = 0.02 > 0.015
    const kneeVec = toVec(lm[LM.LEFT_KNEE]);
    const ankleVec = kneeVec.clone().add(new THREE.Vector3(0, -0.4, 0.015));
    lm[LM.LEFT_ANKLE] = { ...fromVec(ankleVec), visibility: 1 };

    const out = clampHingeJoints(lm);

    expect(out[LM.LEFT_ANKLE]).toEqual(lm[LM.LEFT_ANKLE]);
  });

  it("低visibilityの脚は無変更（ミラー対象の折れフィクスチャでも駆動ゲート未満ならスキップ）", () => {
    const lm = baseLandmarks();
    lm[LM.LEFT_KNEE] = { x: 0.1, y: 0.4, z: 0, visibility: 0.1 }; // minDrive(0.3)未満
    lm[LM.LEFT_ANKLE] = { x: 0.1, y: 0.5, z: -0.3, visibility: 0.1 };

    const out = clampHingeJoints(lm);

    expect(out[LM.LEFT_KNEE]).toEqual(lm[LM.LEFT_KNEE]);
    expect(out[LM.LEFT_ANKLE]).toEqual(lm[LM.LEFT_ANKLE]);
  });

  it("坐位相当（大腿がほぼ骨盤前方と平行）はf_perp退化でスキップされ無変更", () => {
    const lm = baseLandmarks();
    // toVec(knee)-toVec(hip) = (0,0,0.4) ≈ frontAxis(0,0,1) と平行
    lm[LM.LEFT_KNEE] = { x: 0.1, y: 0, z: -0.4, visibility: 1 };
    lm[LM.LEFT_ANKLE] = { x: 0.1, y: 0.3, z: -0.7, visibility: 1 };

    const out = clampHingeJoints(lm);

    expect(out[LM.LEFT_KNEE]).toEqual(lm[LM.LEFT_KNEE]);
    expect(out[LM.LEFT_ANKLE]).toEqual(lm[LM.LEFT_ANKLE]);
  });

  it("肘屈曲170°は150°にクランプされ、wristと指landmarkが追従する", () => {
    const lm = baseLandmarks();
    lm[LM.LEFT_ELBOW] = { x: 0.1, y: -0.1, z: 0, visibility: 1 }; // uHat(Three) = (0,-1,0)
    lm[LM.LEFT_PINKY] = { x: 0.3, y: -0.05, z: 0.02, visibility: 1 };
    lm[LM.LEFT_INDEX] = { x: 0.32, y: -0.02, z: 0.01, visibility: 1 };
    lm[LEFT_THUMB] = { x: 0.25, y: -0.03, z: -0.02, visibility: 1 };

    const legLen = 0.4;
    const theta170 = (170 * Math.PI) / 180;
    const elbowVec = toVec(lm[LM.LEFT_ELBOW]);
    const wAt170 = new THREE.Vector3(
      Math.sin(theta170),
      -Math.cos(theta170),
      0
    ).multiplyScalar(legLen);
    const wristVec170 = elbowVec.clone().add(wAt170);
    lm[LM.LEFT_WRIST] = { ...fromVec(wristVec170), visibility: 1 };

    const before = {
      pinky: { ...lm[LM.LEFT_PINKY] },
      index: { ...lm[LM.LEFT_INDEX] },
      thumb: { ...lm[LEFT_THUMB] },
      wrist: { ...lm[LM.LEFT_WRIST] },
    };

    const out = clampHingeJoints(lm);

    const theta150 = (150 * Math.PI) / 180;
    const wAt150 = new THREE.Vector3(
      Math.sin(theta150),
      -Math.cos(theta150),
      0
    ).multiplyScalar(legLen);
    const expectedWristVec = elbowVec.clone().add(wAt150);
    const expectedWrist = fromVec(expectedWristVec);

    expect(out[LM.LEFT_WRIST].x).toBeCloseTo(expectedWrist.x, 6);
    expect(out[LM.LEFT_WRIST].y).toBeCloseTo(expectedWrist.y, 6);
    expect(out[LM.LEFT_WRIST].z).toBeCloseTo(expectedWrist.z, 6);

    const deltaX = out[LM.LEFT_WRIST].x - before.wrist.x;
    const deltaY = out[LM.LEFT_WRIST].y - before.wrist.y;
    const deltaZ = out[LM.LEFT_WRIST].z - before.wrist.z;

    expect(out[LM.LEFT_PINKY].x).toBeCloseTo(before.pinky.x + deltaX, 6);
    expect(out[LM.LEFT_PINKY].y).toBeCloseTo(before.pinky.y + deltaY, 6);
    expect(out[LM.LEFT_PINKY].z).toBeCloseTo(before.pinky.z + deltaZ, 6);

    expect(out[LM.LEFT_INDEX].x).toBeCloseTo(before.index.x + deltaX, 6);
    expect(out[LM.LEFT_INDEX].y).toBeCloseTo(before.index.y + deltaY, 6);
    expect(out[LM.LEFT_INDEX].z).toBeCloseTo(before.index.z + deltaZ, 6);

    expect(out[LEFT_THUMB].x).toBeCloseTo(before.thumb.x + deltaX, 6);
    expect(out[LEFT_THUMB].y).toBeCloseTo(before.thumb.y + deltaY, 6);
    expect(out[LEFT_THUMB].z).toBeCloseTo(before.thumb.z + deltaZ, 6);
  });

  it("右膝の逆曲がりも左と対称にミラーされる（左右の添字取り違え検出）", () => {
    const lm = baseLandmarks();
    lm[LM.RIGHT_KNEE] = { x: -0.1, y: 0.4, z: 0, visibility: 1 };
    // 左膝ミラーテストと x 符号だけ反転した対称フィクスチャ
    lm[LM.RIGHT_ANKLE] = { x: -0.1, y: 0.5, z: -0.3, visibility: 1 };
    lm[RIGHT_HEEL] = { x: -0.1, y: 0.55, z: -0.32, visibility: 1 };
    lm[LM.RIGHT_FOOT_INDEX] = { x: -0.15, y: 0.6, z: -0.35, visibility: 1 };

    const out = clampHingeJoints(lm);

    expect(out[LM.RIGHT_ANKLE].x).toBeCloseTo(-0.1, 6);
    expect(out[LM.RIGHT_ANKLE].y).toBeCloseTo(0.5, 6);
    expect(out[LM.RIGHT_ANKLE].z).toBeCloseTo(0.3, 6);
    expect(out[RIGHT_HEEL].z).toBeCloseTo(0.28, 6);
    expect(out[LM.RIGHT_FOOT_INDEX].z).toBeCloseTo(0.25, 6);
  });

  it("低visibilityの腕は無変更（肘屈曲170°でも駆動ゲート未満ならスキップ）", () => {
    const lm = baseLandmarks();
    lm[LM.LEFT_ELBOW] = { x: 0.1, y: -0.1, z: 0, visibility: 0.1 }; // minDrive(0.3)未満
    const theta170 = (170 * Math.PI) / 180;
    const elbowVec = toVec(lm[LM.LEFT_ELBOW]);
    const wAt170 = new THREE.Vector3(
      Math.sin(theta170),
      -Math.cos(theta170),
      0
    ).multiplyScalar(0.4);
    lm[LM.LEFT_WRIST] = { ...fromVec(elbowVec.clone().add(wAt170)), visibility: 0.1 };

    const out = clampHingeJoints(lm);

    expect(out[LM.LEFT_ELBOW]).toEqual(lm[LM.LEFT_ELBOW]);
    expect(out[LM.LEFT_WRIST]).toEqual(lm[LM.LEFT_WRIST]);
  });

  it("入力配列・要素を変更しない（イミュータビリティ）", () => {
    const lm = baseLandmarks();
    lm[LM.LEFT_KNEE] = { x: 0.1, y: 0.4, z: 0, visibility: 1 };
    lm[LM.LEFT_ANKLE] = { x: 0.1, y: 0.5, z: -0.3, visibility: 1 };
    lm[LEFT_HEEL] = { x: 0.1, y: 0.55, z: -0.32, visibility: 1 };
    lm[LM.LEFT_FOOT_INDEX] = { x: 0.15, y: 0.6, z: -0.35, visibility: 1 };
    const snapshot = JSON.parse(JSON.stringify(lm));

    const out = clampHingeJoints(lm);

    expect(lm).toEqual(snapshot);
    expect(out).not.toBe(lm);
  });
});

/** テスト用: 2 landmark（子, 親）から Three.js 空間の方向ベクトル(子-親)を求める */
const fromVecToThreeDelta = (child: RawLandmark, parent: RawLandmark): THREE.Vector3 =>
  toVec(child).sub(toVec(parent));
