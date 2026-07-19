import * as THREE from "three";
import { LM, VISIBILITY_GATE, isVisible, toVec, type RawLandmark } from "./muscles";
import { computeHipsRotation } from "./retarget";

/**
 * ヒンジ関節（肘・膝）の可動域制約（#62）。
 *
 * #61 までのリターゲットは landmark をそのまま関節角に写像するため、深度ノイズ・
 * オクルージョンで膝が解剖学的に不可能な前方向へ折れたり、肘/膝が過剰屈曲した
 * ポーズが出うる。retarget/IK/筋推定へ landmark を渡す前にここでサニタイズする。
 */
export const JOINT_LIMITS = {
  /** 膝の最大屈曲角（伸展=0, 全屈曲=PI） */
  maxKneeFlexionRad: (150 * Math.PI) / 180,
  /** 肘の最大屈曲角 */
  maxElbowFlexionRad: (150 * Math.PI) / 180,
  /** 前方成分がこの比率（下腿/前腕長比）以下ならミラーしない（直立時のジッタ対策） */
  mirrorDeadband: 0.05,
} as const;

/**
 * MediaPipe pose landmark インデックス（手指・かかと）。
 * muscles.ts の LM には未定義のため、この関節リミット計算専用にここで持つ。
 */
const EXTRA_LM = {
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
} as const;

/**
 * Three.js 空間の delta を MediaPipe landmark 空間へ戻す。
 * toVec は (x, -y, -z) の線形写像で並進を持たないため、delta にも自己逆変換として使える。
 */
const toRawDelta = (v: THREE.Vector3): { x: number; y: number; z: number } => ({
  x: v.x,
  y: -v.y,
  z: -v.z,
});

const shiftLandmark = (
  lm: RawLandmark,
  delta: { x: number; y: number; z: number }
): RawLandmark => ({ ...lm, x: lm.x + delta.x, y: lm.y + delta.y, z: lm.z + delta.z });

/**
 * uHat との角度が maxRad を超える w を、u-w 平面内で回転させて maxRad まで戻す。
 * u,w が平行/反平行（回転軸が不定）の場合は変更しない。
 */
const clampFlexion = (
  uHat: THREE.Vector3,
  w: THREE.Vector3,
  maxRad: number
): { w: THREE.Vector3; clamped: boolean } => {
  const phi = uHat.angleTo(w);
  if (phi <= maxRad) return { w, clamped: false };
  const axis = new THREE.Vector3().crossVectors(uHat, w);
  if (axis.lengthSq() < 1e-12) return { w, clamped: false };
  axis.normalize();
  const q = new THREE.Quaternion().setFromAxisAngle(axis, -(phi - maxRad));
  return { w: w.clone().applyQuaternion(q), clamped: true };
};

/**
 * 膝の逆曲がりミラー＋屈曲クランプ（設計手順3〜6）。
 * 変更が無ければ null（呼び出し側で出力を書き換えない＝イミュータビリティを保つ）。
 */
const sanitizeKnee = (
  hip: RawLandmark,
  knee: RawLandmark,
  ankle: RawLandmark,
  frontAxis: THREE.Vector3
): THREE.Vector3 | null => {
  const Hv = toVec(hip);
  const Kv = toVec(knee);
  const Av = toVec(ankle);
  const u = Kv.clone().sub(Hv);
  const w0 = Av.clone().sub(Kv);
  if (u.lengthSq() === 0 || w0.lengthSq() === 0) return null;
  const uHat = u.normalize();

  const proj = uHat.clone().multiplyScalar(frontAxis.dot(uHat));
  const fPerpRaw = frontAxis.clone().sub(proj);
  const fPerpLen = fPerpRaw.length();
  if (fPerpLen < 1e-6) return null; // 大腿が骨盤前方とほぼ平行（坐位・長座など）
  const fPerp = fPerpRaw.multiplyScalar(1 / fPerpLen);

  let w = w0;
  let touched = false;
  const wLen = w0.length();
  const d = w0.dot(fPerp);
  if (d > JOINT_LIMITS.mirrorDeadband * wLen) {
    w = w0.clone().sub(fPerp.clone().multiplyScalar(2 * d));
    touched = true;
  }

  const clampResult = clampFlexion(uHat, w, JOINT_LIMITS.maxKneeFlexionRad);
  if (clampResult.clamped) touched = true;

  return touched ? clampResult.w : null;
};

/**
 * 肘の屈曲クランプのみ（逆曲がりミラーは実装しない。設計判断: #62 参照）。
 */
const sanitizeElbow = (
  shoulder: RawLandmark,
  elbow: RawLandmark,
  wrist: RawLandmark
): THREE.Vector3 | null => {
  const Sv = toVec(shoulder);
  const Ev = toVec(elbow);
  const Wv = toVec(wrist);
  const u = Ev.clone().sub(Sv);
  const w0 = Wv.clone().sub(Ev);
  if (u.lengthSq() === 0 || w0.lengthSq() === 0) return null;
  const uHat = u.normalize();

  const { w, clamped } = clampFlexion(uHat, w0, JOINT_LIMITS.maxElbowFlexionRad);
  return clamped ? w : null;
};

/**
 * elbow/knee をヒンジ関節として可動域制約でサニタイズした landmark 配列を返す。
 * 入力配列・要素は変更しない（新しい配列/オブジェクトを返す）。
 *
 * minDrive は呼び出し側が駆動ゲートと同じ値を渡すこと（#61 の融合成立時は
 * VISIBILITY_GATE.minDriveFused）。ここがズレると「駆動されるのにクランプ
 * されない」部位が生じる。
 */
export const clampHingeJoints = (
  landmarks: RawLandmark[],
  minDrive: number = VISIBILITY_GATE.minDrive
): RawLandmark[] => {
  const out = landmarks.slice();

  const applyDelta = (idx: number, delta: { x: number; y: number; z: number }): void => {
    const lm = out[idx];
    if (!lm) return;
    out[idx] = shiftLandmark(lm, delta);
  };

  const processKnee = (
    hipIdx: number,
    kneeIdx: number,
    ankleIdx: number,
    heelIdx: number,
    footIdx: number,
    frontAxis: THREE.Vector3 | null
  ): void => {
    const hip = landmarks[hipIdx];
    const knee = landmarks[kneeIdx];
    const ankle = landmarks[ankleIdx];
    if (!hip || !knee || !ankle) return;
    if (
      !isVisible(hip, minDrive) ||
      !isVisible(knee, minDrive) ||
      !isVisible(ankle, minDrive)
    )
      return;
    if (!frontAxis) return;

    const newW = sanitizeKnee(hip, knee, ankle, frontAxis);
    if (!newW) return;

    const newAv = toVec(knee).add(newW);
    const delta = toRawDelta(newAv.sub(toVec(ankle)));

    applyDelta(ankleIdx, delta);
    applyDelta(heelIdx, delta);
    applyDelta(footIdx, delta);
  };

  const processElbow = (
    shoulderIdx: number,
    elbowIdx: number,
    wristIdx: number,
    pinkyIdx: number,
    indexIdx: number,
    thumbIdx: number
  ): void => {
    const shoulder = landmarks[shoulderIdx];
    const elbow = landmarks[elbowIdx];
    const wrist = landmarks[wristIdx];
    if (!shoulder || !elbow || !wrist) return;
    if (
      !isVisible(shoulder, minDrive) ||
      !isVisible(elbow, minDrive) ||
      !isVisible(wrist, minDrive)
    )
      return;

    const newW = sanitizeElbow(shoulder, elbow, wrist);
    if (!newW) return;

    const newWv = toVec(elbow).add(newW);
    const delta = toRawDelta(newWv.sub(toVec(wrist)));

    applyDelta(wristIdx, delta);
    applyDelta(pinkyIdx, delta);
    applyDelta(indexIdx, delta);
    applyDelta(thumbIdx, delta);
  };

  const hipsQ = computeHipsRotation(landmarks);
  const frontAxis = hipsQ ? new THREE.Vector3(0, 0, 1).applyQuaternion(hipsQ) : null;

  processKnee(
    LM.LEFT_HIP,
    LM.LEFT_KNEE,
    LM.LEFT_ANKLE,
    EXTRA_LM.LEFT_HEEL,
    LM.LEFT_FOOT_INDEX,
    frontAxis
  );
  processKnee(
    LM.RIGHT_HIP,
    LM.RIGHT_KNEE,
    LM.RIGHT_ANKLE,
    EXTRA_LM.RIGHT_HEEL,
    LM.RIGHT_FOOT_INDEX,
    frontAxis
  );

  processElbow(
    LM.LEFT_SHOULDER,
    LM.LEFT_ELBOW,
    LM.LEFT_WRIST,
    LM.LEFT_PINKY,
    LM.LEFT_INDEX,
    EXTRA_LM.LEFT_THUMB
  );
  processElbow(
    LM.RIGHT_SHOULDER,
    LM.RIGHT_ELBOW,
    LM.RIGHT_WRIST,
    LM.RIGHT_PINKY,
    LM.RIGHT_INDEX,
    EXTRA_LM.RIGHT_THUMB
  );

  return out;
};
