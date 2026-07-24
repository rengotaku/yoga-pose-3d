import * as THREE from "three";
import {
  type Penetration,
  type SegmentCapsule,
  SELF_PENETRATION,
  buildBodyCapsules,
} from "./poseValidity";
import * as selfModule from "./penetrationNarrowPhase";

/** 体節名に対応するボーンサフィックス集合 */
const SEGMENT_BONE_SUFFIXES: Record<string, string[]> = {
  chest: ["Spine1", "Spine2", "Neck"],
  abdomen: ["Spine"],
  pelvis: ["Hips"],
  head: ["Head"],
  "upperArm:L": ["LeftArm"],
  "upperArm:R": ["RightArm"],
  "foreArm:L": ["LeftForeArm"],
  "foreArm:R": ["RightForeArm"],
  "hand:L": ["LeftHand", "LeftHandMiddle1", "LeftHandIndex1", "LeftHandThumb1"],
  "hand:R": ["RightHand", "RightHandMiddle1", "RightHandIndex1", "RightHandThumb1"],
  "thigh:L": ["LeftUpLeg"],
  "thigh:R": ["RightUpLeg"],
  "calf:L": ["LeftLeg"],
  "calf:R": ["RightLeg"],
  "foot:L": ["LeftFoot", "LeftToeBase"],
  "foot:R": ["RightFoot", "RightToeBase"],
};

/** ペア名から fail 閾値を引く */
const getPairFailTolerance = (a: string, b: string): number => {
  const key = [a, b].sort().join("|");
  const override = (
    SELF_PENETRATION.perPairToleranceM.overrides as Record<
      string,
      { warn: number; fail: number }
    >
  )[key];
  return override?.fail ?? SELF_PENETRATION.perPairToleranceM.failDefault;
};

type MeshGeometryData = {
  vertices: THREE.Vector3[];
  triangles: [number, number, number][];
};

/**
 * Object3D / SkinnedMesh から指定された体節に対応する world 座標の頂点・三角形集合を抽出する
 */
const extractSegmentGeometry = (
  root: THREE.Object3D,
  segmentName: string,
  fallbackChildIndex?: number
): MeshGeometryData => {
  const suffixes = SEGMENT_BONE_SUFFIXES[segmentName] ?? [];
  const vertices: THREE.Vector3[] = [];
  const triangles: [number, number, number][] = [];

  // root 以下に SkinnedMesh があるか確認
  let hasSkinnedMesh = false;
  root.traverse((child) => {
    if (child instanceof THREE.SkinnedMesh && child.skeleton) {
      hasSkinnedMesh = true;
    }
  });

  let meshCount = 0;
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;

    const isSkinned = child instanceof THREE.SkinnedMesh && child.skeleton;

    // SkinnedMesh が存在する場合、非 SkinnedMesh (マーカー等) は無視
    if (hasSkinnedMesh && !isSkinned) {
      return;
    }

    const isTargetMesh =
      fallbackChildIndex !== undefined && meshCount === fallbackChildIndex;
    meshCount++;

    const geom = child.geometry;
    const posAttr = geom.getAttribute("position");
    if (!posAttr) return;

    const skinIndexAttr = geom.getAttribute("skinIndex");
    const skinWeightAttr = geom.getAttribute("skinWeight");

    // 各頂点が該当セグメントに属するか判定
    const vertexMap = new Map<number, number>(); // original index -> extracted index
    const tmpV = new THREE.Vector3();

    for (let i = 0; i < posAttr.count; i++) {
      let belongs = false;

      if (isSkinned && skinIndexAttr && skinWeightAttr) {
        const bones = child.skeleton.bones;
        let maxW = 0;
        let domBoneIdx = 0;
        for (let k = 0; k < 4; k++) {
          const w = skinWeightAttr.getComponent(i, k);
          if (w > maxW) {
            maxW = w;
            domBoneIdx = skinIndexAttr.getComponent(i, k);
          }
        }
        const boneName = bones[domBoneIdx]?.name ?? "";
        if (suffixes.some((s) => boneName.endsWith(s) || boneName === s)) {
          belongs = true;
        }
      } else {
        belongs = isTargetMesh;
      }

      if (belongs) {
        if (isSkinned) {
          child.getVertexPosition(i, tmpV);
          tmpV.applyMatrix4(child.matrixWorld);
        } else {
          tmpV.fromBufferAttribute(posAttr, i);
          tmpV.applyMatrix4(child.matrixWorld);
        }
        vertexMap.set(i, vertices.length);
        vertices.push(tmpV.clone());
      }
    }

    // 三角形の抽出
    const index = geom.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const i0 = index.getX(i);
        const i1 = index.getX(i + 1);
        const i2 = index.getX(i + 2);
        if (vertexMap.has(i0) && vertexMap.has(i1) && vertexMap.has(i2)) {
          triangles.push([vertexMap.get(i0)!, vertexMap.get(i1)!, vertexMap.get(i2)!]);
        }
      }
    } else {
      for (let i = 0; i < posAttr.count; i += 3) {
        if (vertexMap.has(i) && vertexMap.has(i + 1) && vertexMap.has(i + 2)) {
          triangles.push([
            vertexMap.get(i)!,
            vertexMap.get(i + 1)!,
            vertexMap.get(i + 2)!,
          ]);
        }
      }
    }
  });

  return { vertices, triangles };
};

/**
 * 2 つのカプセルペア（体節）間のメッシュ実表面での最小距離を計算する。
 * AABB で候補三角形を絞り込み、頂点–三角形距離で求める。
 * 負値なら交差、0 なら接触、正値なら離間。
 */
export const narrowPhaseDistance = (
  caps: [SegmentCapsule, SegmentCapsule],
  mesh: THREE.Object3D
): number => {
  mesh.updateMatrixWorld(true);

  const geomA = extractSegmentGeometry(mesh, caps[0].name, 0);
  const geomB = extractSegmentGeometry(mesh, caps[1].name, 1);

  if (
    geomA.vertices.length === 0 ||
    geomB.vertices.length === 0 ||
    (geomA.triangles.length === 0 && geomB.triangles.length === 0)
  ) {
    // スキン頂点が抽出できない fixture 等の場合は 0 を返す
    return 0;
  }

  // AABB による絞り込み
  const boxA = new THREE.Box3().setFromPoints(geomA.vertices);
  const boxB = new THREE.Box3().setFromPoints(geomB.vertices);

  // マージン付き AABB 判定
  const margin = 0.1;
  const expandedBoxA = boxA.clone().expandByScalar(margin);
  if (!expandedBoxA.intersectsBox(boxB)) {
    // 完全に離れている場合は AABB 間の距離の概算を返す
    return boxA.distanceToPoint(boxB.min);
  }

  const tri = new THREE.Triangle();
  const closestP = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const bary = new THREE.Vector3();

  let minAbsDistance = Infinity;
  let maxPenetrationDepth = 0; // 貫通深度 (正の値として記録)
  let isStraddledPenetration = false;

  // 1. A の頂点 vs B の各三角形
  for (const triBIdx of geomB.triangles) {
    const b0 = geomB.vertices[triBIdx[0]];
    const b1 = geomB.vertices[triBIdx[1]];
    const b2 = geomB.vertices[triBIdx[2]];
    tri.set(b0, b1, b2);
    tri.getNormal(normal);

    let hasFront = false;
    let hasBack = false;

    for (const vA of geomA.vertices) {
      tri.closestPointToPoint(vA, closestP);
      const absDist = vA.distanceTo(closestP);
      if (absDist < minAbsDistance) {
        minAbsDistance = absDist;
      }

      dir.subVectors(vA, closestP);
      const dot = dir.dot(normal);

      tri.getBarycoord(closestP, bary);
      const isInsideTriangle = bary.x >= -1e-3 && bary.y >= -1e-3 && bary.z >= -1e-3;

      if (isInsideTriangle) {
        if (dot > 1e-5) hasFront = true;
        if (dot < -1e-5) {
          hasBack = true;
          if (-dot > maxPenetrationDepth) {
            maxPenetrationDepth = -dot;
          }
        }
      }
    }

    if (hasFront && hasBack) {
      isStraddledPenetration = true;
    }
  }

  // 2. B の頂点 vs A の各三角形
  for (const triAIdx of geomA.triangles) {
    const a0 = geomA.vertices[triAIdx[0]];
    const a1 = geomA.vertices[triAIdx[1]];
    const a2 = geomA.vertices[triAIdx[2]];
    tri.set(a0, a1, a2);
    tri.getNormal(normal);

    let hasFront = false;
    let hasBack = false;

    for (const vB of geomB.vertices) {
      tri.closestPointToPoint(vB, closestP);
      const absDist = vB.distanceTo(closestP);
      if (absDist < minAbsDistance) {
        minAbsDistance = absDist;
      }

      dir.subVectors(vB, closestP);
      const dot = dir.dot(normal);

      tri.getBarycoord(closestP, bary);
      const isInsideTriangle = bary.x >= -1e-3 && bary.y >= -1e-3 && bary.z >= -1e-3;

      if (isInsideTriangle) {
        if (dot > 1e-5) hasFront = true;
        if (dot < -1e-5) {
          hasBack = true;
          if (-dot > maxPenetrationDepth) {
            maxPenetrationDepth = -dot;
          }
        }
      }
    }

    if (hasFront && hasBack) {
      isStraddledPenetration = true;
    }
  }

  if (!Number.isFinite(minAbsDistance)) return 0;

  if (isStraddledPenetration) {
    return -Math.max(maxPenetrationDepth, minAbsDistance);
  }

  // 面をまたがっていない場合
  return minAbsDistance;
};

/**
 * detectSelfPenetrations の判定結果（broad phase）に対し、
 * fail 判定および fail 直下 5mm の warn ペアに narrow phase を適用して severity を格下げ補正する。
 */
export const applyNarrowPhaseRefinement = (
  pens: Penetration[],
  mesh: THREE.Object3D
): Penetration[] => {
  const capsules = buildBodyCapsules(mesh);
  const capsuleMap = new Map<string, SegmentCapsule>();
  for (const c of capsules) {
    capsuleMap.set(c.name, c);
  }

  return pens.map((p) => {
    const failTol = getPairFailTolerance(p.a, p.b);
    // broad で fail 判定 + fail 直下 5mm (failTol - 0.005) 以内の warn ペアのみ narrow 対象
    const isTarget =
      p.severity === "fail" || (p.severity === "warn" && p.depthM >= failTol - 0.005);

    if (!isTarget) {
      return p;
    }

    const capA = capsuleMap.get(p.a);
    const capB = capsuleMap.get(p.b);
    const caps: [SegmentCapsule, SegmentCapsule] = [
      capA ?? { name: p.a, a: new THREE.Vector3(), b: new THREE.Vector3(), radius: 0.05 },
      capB ?? { name: p.b, a: new THREE.Vector3(), b: new THREE.Vector3(), radius: 0.05 },
    ];

    // narrowPhaseDistance を呼び出し
    const dist = selfModule.narrowPhaseDistance(caps, mesh);

    let nextSeverity = p.severity;
    if (dist > 0) {
      // 実表面距離 > 0 なら warn へ格下げ
      nextSeverity = "warn";
    }

    return {
      ...p,
      severity: nextSeverity,
      narrowRefined: true,
    };
  });
};
