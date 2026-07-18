import * as THREE from "three";
import { type RawLandmark } from "./muscles";
import { resolveBoneName } from "./retarget";
import { detectGroundContacts, solveTwoBoneIK, type LimbKey } from "./ik";

/**
 * 胴体との自己衝突回避（#44）。
 *
 * リターゲットは landmark の分節方向にボーンを回すだけなので、実人体で
 * 「胸の表面に手を置く」方向ベクトルは、胸郭がより厚い/腕が短いマネキン
 * では胸の内部を通り、前腕・手が胴体メッシュにめり込む。胴体を
 * カプセル（spine→neck の線分 + 半径）で近似し、カプセル内に入った
 * 腕の手メッシュを胴体の前方向（belly normal）へ押し出して 2-bone IK で
 * 再ソルブする。radial（軸から放射方向）でなく前方向へ押すのは、胸の前で
 * 腕をクロスするポーズでは肘側が胴体側面に固定され radial では原理的に
 * クリアできず過剰補正になるため（実ポーズも「胸の前面に腕を乗せる」）。
 */
export const TORSO_PUSHOUT = {
  /** 胴体カプセル半径のフォールバック（m）。メッシュ実測が取れないとき */
  torsoRadiusM: 0.13,
  /** push-out 後の表面クリアランス（m。手・前腕メッシュの厚み分）。
   * 前腕・手メッシュの radial 実測が取れないときのフォールバック */
  clearanceM: 0.05,
  /** メッシュ実測時の表面クリアランス（m。最深頂点を表面 + この距離へ置く） */
  meshClearanceM: 0.02,
  /**
   * カプセル半径のメッシュ実測に使う分位点。max だと肩・胸の外れ値で
   * 半径が過大になり、通常ポーズの腕まで押し出してしまう
   */
  radiusQuantile: 0.95,
} as const;

export type Capsule = {
  a: THREE.Vector3;
  b: THREE.Vector3;
  radius: number;
};

/** 点 p から線分 ab への最近点 */
export const closestPointOnSegment = (
  p: THREE.Vector3,
  a: THREE.Vector3,
  b: THREE.Vector3
): THREE.Vector3 => {
  const ab = b.clone().sub(a);
  const len2 = ab.lengthSq();
  if (len2 < 1e-12) return a.clone();
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / len2));
  return a.clone().add(ab.multiplyScalar(t));
};

const TORSO_BONES = ["mixamorig:Spine", "mixamorig:Spine1", "mixamorig:Spine2"];

/**
 * 胴体カプセルを実測で作る。軸 = Spine（腰）→ Neck（首の付け根）の線分、
 * 半径 = 胴体ボーン支配頂点の軸からの radial 距離の分位点
 * （メッシュが無い/スキン属性が無いテスト環境ではフォールバック定数）。
 */
export const computeTorsoCapsule = (root: THREE.Object3D): Capsule | null => {
  const boneMap = new Map<string, THREE.Bone>();
  root.traverse((child) => {
    if ((child as THREE.Bone).isBone) boneMap.set(child.name, child as THREE.Bone);
  });
  const boneNames = Array.from(boneMap.keys());
  const findBone = (mixamoName: string): THREE.Bone | undefined => {
    const name = resolveBoneName(mixamoName, boneNames);
    return name ? boneMap.get(name) : undefined;
  };
  const spine = findBone("mixamorig:Spine");
  const neck = findBone("mixamorig:Neck");
  if (!spine || !neck) return null;

  root.updateMatrixWorld(true);
  const a = spine.getWorldPosition(new THREE.Vector3());
  const b = neck.getWorldPosition(new THREE.Vector3());

  const torsoBones = new Set<THREE.Object3D>();
  for (const name of TORSO_BONES) {
    const bone = findBone(name);
    if (bone) torsoBones.add(bone);
  }

  const distances: number[] = [];
  const v = new THREE.Vector3();
  root.traverse((child) => {
    if (!(child instanceof THREE.SkinnedMesh)) return;
    const geom = child.geometry;
    const pos = geom.getAttribute("position");
    const skinIndex = geom.getAttribute("skinIndex");
    const skinWeight = geom.getAttribute("skinWeight");
    if (!pos || !skinIndex || !skinWeight) return;
    const torsoIdx = new Set<number>();
    child.skeleton.bones.forEach((bone, i) => {
      if (torsoBones.has(bone)) torsoIdx.add(i);
    });
    if (torsoIdx.size === 0) return;
    for (let i = 0; i < pos.count; i++) {
      let maxW = 0;
      let domIdx = -1;
      for (let k = 0; k < 4; k++) {
        const w = skinWeight.getComponent(i, k);
        if (w > maxW) {
          maxW = w;
          domIdx = skinIndex.getComponent(i, k);
        }
      }
      if (!torsoIdx.has(domIdx)) continue;
      child.getVertexPosition(i, v);
      v.applyMatrix4(child.matrixWorld);
      distances.push(v.distanceTo(closestPointOnSegment(v, a, b)));
    }
  });

  let radius: number = TORSO_PUSHOUT.torsoRadiusM;
  if (distances.length > 0) {
    distances.sort((x, y) => x - y);
    const idx = Math.min(
      distances.length - 1,
      Math.floor(distances.length * TORSO_PUSHOUT.radiusQuantile)
    );
    radius = distances[idx];
  }
  return { a, b, radius };
};

/**
 * bone とその子孫ボーンが支配する頂点の、カプセル軸から胴体前方向
 * forward への符号付き距離（(頂点 - 軸最近点)・forward）の最小値を返す。
 * 手メッシュの胸前面への侵入量を実測するために使う。
 * 該当頂点が無ければ null（スキン属性を持たないテスト環境等）。
 */
export const computeLimbMinForward = (
  root: THREE.Object3D,
  bone: THREE.Bone,
  capsule: Capsule,
  forward: THREE.Vector3
): number | null => {
  const limbBones = new Set<THREE.Object3D>();
  bone.traverse((c) => {
    if ((c as THREE.Bone).isBone) limbBones.add(c);
  });
  let minR = Infinity;
  const v = new THREE.Vector3();
  root.traverse((child) => {
    if (!(child instanceof THREE.SkinnedMesh)) return;
    const geom = child.geometry;
    const pos = geom.getAttribute("position");
    const skinIndex = geom.getAttribute("skinIndex");
    const skinWeight = geom.getAttribute("skinWeight");
    if (!pos || !skinIndex || !skinWeight) return;
    const limbIdx = new Set<number>();
    child.skeleton.bones.forEach((b, i) => {
      if (limbBones.has(b)) limbIdx.add(i);
    });
    if (limbIdx.size === 0) return;
    for (let i = 0; i < pos.count; i++) {
      let maxW = 0;
      let domIdx = -1;
      for (let k = 0; k < 4; k++) {
        const w = skinWeight.getComponent(i, k);
        if (w > maxW) {
          maxW = w;
          domIdx = skinIndex.getComponent(i, k);
        }
      }
      if (!limbIdx.has(domIdx)) continue;
      child.getVertexPosition(i, v);
      v.applyMatrix4(child.matrixWorld);
      const f = v
        .clone()
        .sub(closestPointOnSegment(v, capsule.a, capsule.b))
        .dot(forward);
      if (f < minR) minR = f;
    }
  });
  return Number.isFinite(minR) ? minR : null;
};

type ArmChain = {
  key: LimbKey;
  bones: [string, string, string];
};

const ARM_CHAINS: ArmChain[] = [
  {
    key: "leftHand",
    bones: ["mixamorig:LeftArm", "mixamorig:LeftForeArm", "mixamorig:LeftHand"],
  },
  {
    key: "rightHand",
    bones: ["mixamorig:RightArm", "mixamorig:RightForeArm", "mixamorig:RightHand"],
  },
];

/**
 * 前腕・手の胴体めり込みを push-out で解消する。手首または肘が胴体
 * カプセル内に入っている腕だけを対象に、手首を軸から radial 方向へ
 * 表面 + クリアランスまで押し出した位置を target に 2-bone IK で
 * 再ソルブする。接地している手（床支持）は対象外（接地 IK を壊さない）。
 */
export const applyTorsoPushOut = (
  root: THREE.Object3D,
  landmarks: RawLandmark[]
): void => {
  const capsule = computeTorsoCapsule(root);
  if (!capsule) return;

  const boneMap = new Map<string, THREE.Bone>();
  root.traverse((child) => {
    if ((child as THREE.Bone).isBone) boneMap.set(child.name, child as THREE.Bone);
  });
  const boneNames = Array.from(boneMap.keys());
  const findBone = (mixamoName: string): THREE.Bone | undefined => {
    const name = resolveBoneName(mixamoName, boneNames);
    return name ? boneMap.get(name) : undefined;
  };

  const contacts = detectGroundContacts(landmarks);
  const axisDir = capsule.b.clone().sub(capsule.a).normalize();

  // 胴体の前方向（belly normal）。human-base は pelvis local +Z = belly。
  // カプセル軸に直交化して使う
  const pelvis = findBone("mixamorig:Hips");
  if (!pelvis) return;
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(
    pelvis.getWorldQuaternion(new THREE.Quaternion())
  );
  forward.addScaledVector(axisDir, -forward.dot(axisDir));
  if (forward.lengthSq() < 1e-8) return;
  forward.normalize();

  // push-out の回転で前腕の向きが変わり侵入量もずれるため、実測し直して
  // 2 回反復する（#41 のクリアランス反復と同じ理由）
  for (let iter = 0; iter < 2; iter++) {
    for (const chain of ARM_CHAINS) {
      if (contacts[chain.key]) continue;
      const armBone = findBone(chain.bones[0]);
      const foreBone = findBone(chain.bones[1]);
      const handBone = findBone(chain.bones[2]);
      if (!armBone || !foreBone || !handBone) continue;

      const W = handBone.getWorldPosition(new THREE.Vector3());
      const E = foreBone.getWorldPosition(new THREE.Vector3());
      const vW = W.clone().sub(closestPointOnSegment(W, capsule.a, capsule.b));
      const vE = E.clone().sub(closestPointOnSegment(E, capsule.a, capsule.b));

      // カプセルに触れていない腕は対象外
      const margin = capsule.radius + TORSO_PUSHOUT.clearanceM;
      if (vW.length() >= margin && vE.length() >= margin) continue;
      // 手首が胴体の背面側にある腕（後ろ手など）は前方向へ押せないので対象外。
      // 胸の前でクロスした手は中央を越えて弱い負になり得るため、明確に背面
      // （半径の 3 割超）へ回っている場合のみ除外する
      const wristForward = vW.dot(forward);
      if (wristForward < -capsule.radius * 0.3) continue;

      // 侵入量 = 前面 - 手メッシュの前方向符号付き距離の最小値（実測）。
      // メッシュが無ければ手首関節 + フォールバッククリアランスで代用
      const minForward = computeLimbMinForward(root, handBone, capsule, forward);
      const penetration =
        minForward !== null
          ? capsule.radius + TORSO_PUSHOUT.meshClearanceM - minForward
          : capsule.radius + TORSO_PUSHOUT.clearanceM - wristForward;
      if (penetration <= 0) continue;

      const target = W.clone().addScaledVector(forward, penetration);
      solveTwoBoneIK(armBone, foreBone, handBone, target, axisDir);
    }
  }
  root.updateMatrixWorld(true);
};
