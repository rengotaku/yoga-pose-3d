import * as THREE from "three";
import { LM, type RawLandmark, toVec } from "./muscles";

/**
 * 実際のボーン名リストから、mixamorig標準名に対応する名前をサフィックス一致で探す。
 * GLTFLoader がコロンを除去・置換した（例: "mixamorigHips"）ケースに対応する。
 * @param mixamoName 探したい標準ボーン名（例: "mixamorig:LeftUpLeg"）
 * @param actualBoneNames ロードされたメッシュが持つ実際のボーン名配列
 */
export const resolveBoneName = (
  mixamoName: string,
  actualBoneNames: string[]
): string | undefined => {
  const parts = mixamoName.split(":");
  const suffix = parts[parts.length - 1];
  if (!suffix) return undefined;
  return actualBoneNames.find((name) => name.endsWith(suffix));
};

/**
 * 初期方向ベクトル(initialDir)から目標方向ベクトル(targetDir)への
 * 最短回転（Quaternion）を計算する。
 */
export const computeRotation = (
  initialDir: THREE.Vector3,
  targetDir: THREE.Vector3
): THREE.Quaternion => {
  const q = new THREE.Quaternion();
  const v1 = initialDir.clone().normalize();
  const v2 = targetDir.clone().normalize();
  if (v1.lengthSq() > 0 && v2.lengthSq() > 0) {
    q.setFromUnitVectors(v1, v2);
  }
  return q;
};

/**
 * ランドマーク点p1からp2への方向ベクトルを算出する。
 */
export const computeDirection = (
  p1?: RawLandmark,
  p2?: RawLandmark
): THREE.Vector3 | null => {
  if (!p1 || !p2) return null;
  const dir = toVec(p2).sub(toVec(p1));
  if (dir.lengthSq() === 0) return null;
  return dir.normalize();
};

/**
 * 2つのランドマークの中点（THREE.Vector3）を計算する。
 */
export const computeMidpoint = (
  p1?: RawLandmark,
  p2?: RawLandmark
): THREE.Vector3 | null => {
  if (!p1 || !p2) return null;
  return toVec(p1).add(toVec(p2)).multiplyScalar(0.5);
};

export type JointMapping = {
  parentLm: number;
  childLm: number;
};

/**
 * 四肢のボーンとMediaPipeランドマークインデックス（親→子）の対応表。
 */
export const LIMB_BONE_MAPPINGS: Record<string, JointMapping> = {
  "mixamorig:LeftUpLeg": { parentLm: LM.LEFT_HIP, childLm: LM.LEFT_KNEE },
  "mixamorig:LeftLeg": { parentLm: LM.LEFT_KNEE, childLm: LM.LEFT_ANKLE },
  "mixamorig:LeftFoot": { parentLm: LM.LEFT_ANKLE, childLm: LM.LEFT_FOOT_INDEX },
  "mixamorig:RightUpLeg": { parentLm: LM.RIGHT_HIP, childLm: LM.RIGHT_KNEE },
  "mixamorig:RightLeg": { parentLm: LM.RIGHT_KNEE, childLm: LM.RIGHT_ANKLE },
  "mixamorig:RightFoot": { parentLm: LM.RIGHT_ANKLE, childLm: LM.RIGHT_FOOT_INDEX },
  "mixamorig:LeftArm": { parentLm: LM.LEFT_SHOULDER, childLm: LM.LEFT_ELBOW },
  "mixamorig:LeftForeArm": { parentLm: LM.LEFT_ELBOW, childLm: LM.LEFT_WRIST },
  "mixamorig:RightArm": { parentLm: LM.RIGHT_SHOULDER, childLm: LM.RIGHT_ELBOW },
  "mixamorig:RightForeArm": { parentLm: LM.RIGHT_ELBOW, childLm: LM.RIGHT_WRIST },
};

/**
 * 体幹（Spine）の方向ベクトルを計算する。
 * 腰の中点から肩の中点へのベクトル。
 */
export const computeSpineDirection = (landmarks: RawLandmark[]): THREE.Vector3 | null => {
  const hipMid = computeMidpoint(landmarks[LM.LEFT_HIP], landmarks[LM.RIGHT_HIP]);
  const shMid = computeMidpoint(
    landmarks[LM.LEFT_SHOULDER],
    landmarks[LM.RIGHT_SHOULDER]
  );
  if (!hipMid || !shMid) return null;
  const dir = shMid.clone().sub(hipMid);
  if (dir.lengthSq() === 0) return null;
  return dir.normalize();
};

/**
 * 首・頭（Neck/Head）の方向ベクトルを計算する。
 * 肩の中点から鼻へのベクトル。
 */
export const computeNeckDirection = (landmarks: RawLandmark[]): THREE.Vector3 | null => {
  const shMid = computeMidpoint(
    landmarks[LM.LEFT_SHOULDER],
    landmarks[LM.RIGHT_SHOULDER]
  );
  const nose = landmarks[LM.NOSE] ? toVec(landmarks[LM.NOSE]) : null;
  if (!shMid || !nose) return null;
  const dir = nose.clone().sub(shMid);
  if (dir.lengthSq() === 0) return null;
  return dir.normalize();
};

/**
 * 左右の腰のランドマークとSpineの方向から、Hipsの直交基底クォータニオンを計算する。
 * X軸(右): RIGHT_HIP -> LEFT_HIP
 * Y軸(上): SpineDirection
 * Z軸(前): X と Y の外積
 */
export const computeHipsRotation = (
  landmarks: RawLandmark[]
): THREE.Quaternion | null => {
  const hipL = landmarks[LM.LEFT_HIP];
  const hipR = landmarks[LM.RIGHT_HIP];
  const spineDir = computeSpineDirection(landmarks);

  if (!hipL || !hipR || !spineDir) return null;

  const xDir = computeDirection(hipR, hipL);
  if (!xDir) return null;

  // 正確な直交基底を作る
  const zDir = new THREE.Vector3().crossVectors(xDir, spineDir).normalize();
  if (zDir.lengthSq() === 0) return null;

  const xAxis = new THREE.Vector3().crossVectors(spineDir, zDir).normalize();
  const m = new THREE.Matrix4().makeBasis(xAxis, spineDir, zDir);
  return new THREE.Quaternion().setFromRotationMatrix(m);
};
