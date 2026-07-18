import * as THREE from "three";
import { LM, type RawLandmark } from "./muscles";
import { resolveBoneName } from "./retarget";

/**
 * per-limb 2-bone IK（#41）。
 *
 * マネキンと人体のプロポーション差により、方向リターゲット（回転のみ）では
 * 末端位置の誤差が蓄積し、接地しているはずの足・手が床から浮く。
 * 接地している四肢だけ解析的 2-bone IK で床へ届かせる。
 */
export const CONTACT_IK = {
  /** landmark 最下点からこの範囲内（m）にある末端を接地とみなす */
  contactThresholdM: 0.15,
  /**
   * 足首関節の床からのクリアランス（足メッシュの肉厚分）。
   * 実測（末端ボーン配下の頂点最下点）が取れないときのフォールバック
   */
  footClearanceM: 0.07,
  /** 手首関節の床からのクリアランス（掌の厚み分）。同上フォールバック */
  handClearanceM: 0.035,
  /**
   * リーチ判定に使う割合。1.0 だと関節が伸び切って不自然なため、
   * 少し曲げ余地を残す
   */
  reachMargin: 0.97,
  /**
   * リーチ不足時に胴体全体を下げる量の上限（m）。接地誤検知時の
   * 暴走を抑える安全弁
   */
  maxBodyLowerM: 0.5,
} as const;

export type LimbKey = "leftFoot" | "rightFoot" | "leftHand" | "rightHand";

/**
 * MediaPipe landmarks（world 座標、y 下向き正）から接地している末端を検知する。
 * 足先（FOOT_INDEX）と手首（WRIST）のうち、最下点（y 最大）から
 * contactThresholdM 以内のものを接地と分類する。少なくとも最下点の 1 肢は
 * 常に接地扱いになる（静止ポーズでは何かが体を支えているため妥当）。
 */
export const detectGroundContacts = (
  landmarks: RawLandmark[]
): Record<LimbKey, boolean> => {
  const candidates: [LimbKey, RawLandmark | undefined][] = [
    ["leftFoot", landmarks[LM.LEFT_FOOT_INDEX]],
    ["rightFoot", landmarks[LM.RIGHT_FOOT_INDEX]],
    ["leftHand", landmarks[LM.LEFT_WRIST]],
    ["rightHand", landmarks[LM.RIGHT_WRIST]],
  ];
  const result: Record<LimbKey, boolean> = {
    leftFoot: false,
    rightFoot: false,
    leftHand: false,
    rightHand: false,
  };
  const ys = candidates.filter(([, lm]) => lm).map(([, lm]) => (lm as RawLandmark).y);
  if (ys.length === 0) return result;
  const ground = Math.max(...ys);
  for (const [key, lm] of candidates) {
    if (lm && ground - lm.y <= CONTACT_IK.contactThresholdM) result[key] = true;
  }
  return result;
};

const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));

/** bone の world 回転に delta を前掛けする（親の world 回転で局所化） */
const applyWorldDeltaToBone = (bone: THREE.Bone, q: THREE.Quaternion): void => {
  const parentWorldQ = bone.parent
    ? bone.parent.getWorldQuaternion(new THREE.Quaternion())
    : new THREE.Quaternion();
  const localDelta = parentWorldQ.clone().invert().multiply(q).multiply(parentWorldQ);
  bone.quaternion.premultiply(localDelta);
  bone.updateMatrixWorld(true);
};

/**
 * 解析的 2-bone IK。root（股/肩）→ mid（膝/肘）→ end（足首/手首）の 2 関節を
 * 回して end を target へ届かせる。
 *
 * 1. mid の interior 角を余弦定理で目標距離に合わせる（曲げ平面 = 現在の
 *    R→M→E が張る平面を保存。直線状のときのみ poleHint で平面を決める）
 * 2. root を回して end を target 方向へアラインする
 *
 * 到達不能な target は [|a-b|, a+b] へクランプされ、チェーンが伸び切る/
 * 畳まれる形で最近傍に寄る。
 */
export const solveTwoBoneIK = (
  root: THREE.Bone,
  mid: THREE.Bone,
  end: THREE.Bone,
  target: THREE.Vector3,
  poleHint: THREE.Vector3
): void => {
  root.updateMatrixWorld(true);
  const R = root.getWorldPosition(new THREE.Vector3());
  const M = mid.getWorldPosition(new THREE.Vector3());
  const E = end.getWorldPosition(new THREE.Vector3());
  const a = R.distanceTo(M);
  const b = M.distanceTo(E);
  if (a < 1e-6 || b < 1e-6) return;

  const eps = 1e-4;
  const lo = Math.abs(a - b) + eps;
  const hi = a + b - eps;
  const t = clamp(R.distanceTo(target), lo, hi);

  // 曲げ平面の法線。n 方向に +α 回すと interior 角は α だけ閉じる（実装検証済み）
  const n = new THREE.Vector3().crossVectors(M.clone().sub(R), E.clone().sub(R));
  if (n.lengthSq() < 1e-8) {
    n.crossVectors(target.clone().sub(R), poleHint);
  }
  if (n.lengthSq() < 1e-8) return;
  n.normalize();

  // 1) mid の interior 角: cos φ = (a² + b² - t²) / 2ab
  const cosDesired = clamp((a * a + b * b - t * t) / (2 * a * b), -1, 1);
  const curT = clamp(R.distanceTo(E), lo, hi);
  const cosCurrent = clamp((a * a + b * b - curT * curT) / (2 * a * b), -1, 1);
  const alpha = Math.acos(cosCurrent) - Math.acos(cosDesired);
  applyWorldDeltaToBone(mid, new THREE.Quaternion().setFromAxisAngle(n, alpha));

  // 2) root を回して end を target 方向へ
  const E2 = end.getWorldPosition(new THREE.Vector3());
  const v1 = E2.clone().sub(R);
  const v2 = target.clone().sub(R);
  if (v1.lengthSq() < 1e-8 || v2.lengthSq() < 1e-8) return;
  applyWorldDeltaToBone(
    root,
    new THREE.Quaternion().setFromUnitVectors(v1.normalize(), v2.normalize())
  );
};

/**
 * 末端ボーン（足首/手首）とその子孫ボーンが支配する頂点の world 最小 Y を
 * 返す。IK ターゲットのクリアランス（関節と床の間に挟まるメッシュ肉厚）を
 * モデル実測で決めるために使う。該当頂点が無ければ null。
 */
export const computeLimbLowestY = (
  root: THREE.Object3D,
  endBone: THREE.Bone
): number | null => {
  const limbBones = new Set<THREE.Object3D>();
  endBone.traverse((c) => {
    if ((c as THREE.Bone).isBone) limbBones.add(c);
  });
  let minY = Infinity;
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
      if (v.y < minY) minY = v.y;
    }
  });
  return Number.isFinite(minY) ? minY : null;
};

type ChainSpec = {
  key: LimbKey;
  bones: [string, string, string];
  clearance: number;
};

const CHAINS: ChainSpec[] = [
  {
    key: "leftFoot",
    bones: ["mixamorig:LeftUpLeg", "mixamorig:LeftLeg", "mixamorig:LeftFoot"],
    clearance: CONTACT_IK.footClearanceM,
  },
  {
    key: "rightFoot",
    bones: ["mixamorig:RightUpLeg", "mixamorig:RightLeg", "mixamorig:RightFoot"],
    clearance: CONTACT_IK.footClearanceM,
  },
  {
    key: "leftHand",
    bones: ["mixamorig:LeftArm", "mixamorig:LeftForeArm", "mixamorig:LeftHand"],
    clearance: CONTACT_IK.handClearanceM,
  },
  {
    key: "rightHand",
    bones: ["mixamorig:RightArm", "mixamorig:RightForeArm", "mixamorig:RightHand"],
    clearance: CONTACT_IK.handClearanceM,
  },
];

/**
 * 接地肢のターゲット位置を決める。基本は末端の現在 (x, z) を保って床高さへ
 * 下ろすが、チェーンのリーチが足りない場合はターゲットを root 側へ水平
 * スライドして「床上の到達可能な最近点」にする（実際のポーズでも接地肢は
 * 体の下に入るため、浮かせたままより自然になる）。垂直距離すら届かない
 * ときは (x, z) を保ったままソルバのクランプ（最大リーチで伸び切り）に任せる。
 */
const computeContactTarget = (
  R: THREE.Vector3,
  E: THREE.Vector3,
  reach: number,
  targetY: number
): THREE.Vector3 => {
  const drop = R.y - targetY;
  if (drop >= reach) return new THREE.Vector3(E.x, targetY, E.z);
  const maxH = Math.sqrt(reach * reach - drop * drop);
  const hx = E.x - R.x;
  const hz = E.z - R.z;
  const hDist = Math.hypot(hx, hz);
  if (hDist <= maxH || hDist < 1e-8) {
    return new THREE.Vector3(E.x, targetY, E.z);
  }
  const s = maxH / hDist;
  return new THREE.Vector3(R.x + hx * s, targetY, R.z + hz * s);
};

/**
 * 接地している四肢の末端関節を床（floorY + クリアランス）へ 2-bone IK で
 * 届かせる。
 *
 * マネキンは人体より脚が相対的に短く、全体接地（#36）後の骨盤高さでは
 * 脚のリーチが床に届かないことがある。その場合は胴体全体を下げてから
 * 各接地肢を IK する（下げた結果めり込む側の肢は IK が関節を曲げて床上へ
 * 吸収する。実際のポーズでも接地肢は曲がるため自然になる）。
 */
export const applyContactIK = (
  root: THREE.Object3D,
  landmarks: RawLandmark[],
  floorY: number
): void => {
  const boneMap = new Map<string, THREE.Bone>();
  root.traverse((child) => {
    if ((child as THREE.Bone).isBone) {
      boneMap.set(child.name, child as THREE.Bone);
    }
  });
  const boneNames = Array.from(boneMap.keys());
  const findBone = (mixamoName: string): THREE.Bone | undefined => {
    const name = resolveBoneName(mixamoName, boneNames);
    return name ? boneMap.get(name) : undefined;
  };

  const contacts = detectGroundContacts(landmarks);
  const chains = CHAINS.filter((c) => contacts[c.key])
    .map((c) => ({
      spec: c,
      rootBone: findBone(c.bones[0]),
      midBone: findBone(c.bones[1]),
      endBone: findBone(c.bones[2]),
    }))
    .filter((c) => c.rootBone && c.midBone && c.endBone) as {
    spec: ChainSpec;
    rootBone: THREE.Bone;
    midBone: THREE.Bone;
    endBone: THREE.Bone;
  }[];
  if (chains.length === 0) return;

  root.updateMatrixWorld(true);

  // クリアランス = 末端関節 Y と肢メッシュ最下点の差（実測。無ければ定数）
  const measureClearance = (endBone: THREE.Bone, endY: number, fallback: number) => {
    const limbMin = computeLimbLowestY(root, endBone);
    return limbMin !== null ? Math.max(0, endY - limbMin) : fallback;
  };

  // 1) リーチ不足の接地肢があれば、最も不足している肢に合わせて胴体を下げる
  let lowerBy = 0;
  for (const { spec, rootBone, midBone, endBone } of chains) {
    const R = rootBone.getWorldPosition(new THREE.Vector3());
    const M = midBone.getWorldPosition(new THREE.Vector3());
    const E = endBone.getWorldPosition(new THREE.Vector3());
    const reach = (R.distanceTo(M) + M.distanceTo(E)) * CONTACT_IK.reachMargin;
    const clearance = measureClearance(endBone, E.y, spec.clearance);
    const drop = R.y - (floorY + clearance);
    const deficit = drop - reach;
    if (deficit > lowerBy) lowerBy = deficit;
  }
  if (lowerBy > 0) {
    root.position.y -= Math.min(lowerBy, CONTACT_IK.maxBodyLowerM);
    root.updateMatrixWorld(true);
  }

  // 2) 各接地肢を床 + クリアランスへ IK（上下どちら向きでもスナップする）。
  //    IK の回転で肢の向きが変わりクリアランスもずれるため、実測し直して
  //    2 回反復する
  for (let iter = 0; iter < 2; iter++) {
    for (const { spec, rootBone, midBone, endBone } of chains) {
      const R = rootBone.getWorldPosition(new THREE.Vector3());
      const M = midBone.getWorldPosition(new THREE.Vector3());
      const E = endBone.getWorldPosition(new THREE.Vector3());
      const clearance = measureClearance(endBone, E.y, spec.clearance);
      const targetY = floorY + clearance;
      if (Math.abs(E.y - targetY) < 1e-3) continue;

      const reach = R.distanceTo(M) + M.distanceTo(E) - 1e-4;
      const target = computeContactTarget(R, E, reach, targetY);
      solveTwoBoneIK(rootBone, midBone, endBone, target, new THREE.Vector3(0, 1, 0));
    }
  }
};
