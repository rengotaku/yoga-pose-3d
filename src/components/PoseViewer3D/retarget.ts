import * as THREE from "three";
import { LM, type RawLandmark, toVec } from "./muscles";

export const BONE_ALIASES: Record<string, string[]> = {
  Hips: ["pelvis"],
  Spine: ["spine_01"],
  Spine1: ["spine_02"],
  Spine2: ["spine_03"],
  Neck: ["neck_01"],
  Head: ["head"],
  LeftShoulder: ["clavicle_l"],
  RightShoulder: ["clavicle_r"],
  LeftArm: ["upperarm_l"],
  LeftForeArm: ["lowerarm_l"],
  LeftHand: ["hand_l"],
  RightArm: ["upperarm_r"],
  RightForeArm: ["lowerarm_r"],
  RightHand: ["hand_r"],
  LeftUpLeg: ["thigh_l"],
  LeftLeg: ["calf_l"],
  LeftFoot: ["foot_l"],
  LeftToeBase: ["ball_l"],
  RightUpLeg: ["thigh_r"],
  RightLeg: ["calf_r"],
  RightFoot: ["foot_r"],
  RightToeBase: ["ball_r"],
};

/**
 * 実際のボーン名リストから、mixamorig標準名に対応する名前をサフィックス一致で探す。
 * GLTFLoader がコロンを除去・置換した（例: "mixamorigHips"）ケースに対応する。
 * 見つからない場合は別名リスト(BONE_ALIASES)との完全一致で探す。
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

  let found = actualBoneNames.find((name) => name.endsWith(suffix));
  if (found) return found;

  const aliases = BONE_ALIASES[suffix];
  if (aliases) {
    found = actualBoneNames.find((name) => aliases.includes(name));
    if (found) return found;
  }

  return undefined;
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

/**
 * 体幹の目標回転（Quaternion）を Spine/Spine1/Spine2 の 3 ボーンに角度分配する。
 * 合成後の回転が元の targetRotation と一致するように、slerp で重み分割を行う。
 *
 * @param targetRotation Spine 全体に適用したい目標の回転
 * @param weights Spine, Spine1, Spine2 への分配重み。合計が 1 になること（デフォルト: [1/3, 1/3, 1/3]）
 * @returns [Spine用, Spine1用, Spine2用] の Quaternion 配列
 */
export const distributeSpineRotation = (
  targetRotation: THREE.Quaternion,
  weights: [number, number, number] = [1 / 3, 1 / 3, 1 / 3]
): [THREE.Quaternion, THREE.Quaternion, THREE.Quaternion] => {
  const q0 = new THREE.Quaternion().slerp(targetRotation, weights[0]);
  const q1 = new THREE.Quaternion().slerp(targetRotation, weights[1]);
  const q2 = new THREE.Quaternion().slerp(targetRotation, weights[2]);
  return [q0, q1, q2];
};
