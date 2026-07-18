import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  resolveBoneName,
  computeRotation,
  computeHipsRotation,
  computeSpineDirection,
  computeNeckDirection,
  computeDirection,
  LIMB_BONE_MAPPINGS,
} from "./retarget";
import { LM, toVec, heatColor } from "./muscles";
import type { RawLandmark, ActivationMap } from "./muscles";

const NEUTRAL = 0xb98a7a;

export const loadMannequin = (url: string): Promise<THREE.Group> => {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => resolve(gltf.scene),
      undefined,
      (error) => reject(error)
    );
  });
};

export const applyPoseToSkeleton = (root: THREE.Object3D, landmarks: RawLandmark[]) => {
  root.updateMatrixWorld(true);

  root.traverse((obj) => {
    if (!(obj as THREE.Bone).isBone) return;
    const bone = obj as THREE.Bone;
    const name = bone.name;

    // Hips
    if (resolveBoneName("mixamorig:Hips", [name])) {
      const q = computeHipsRotation(landmarks);
      if (q) {
        const parentWorldQ = bone.parent
          ? bone.parent.getWorldQuaternion(new THREE.Quaternion())
          : new THREE.Quaternion();
        const localQ = parentWorldQ.clone().invert().multiply(q);
        bone.quaternion.copy(localQ);
        bone.updateMatrixWorld(true);
      }
      return;
    }

    // Spine
    if (
      resolveBoneName("mixamorig:Spine", [name]) ||
      resolveBoneName("mixamorig:Spine1", [name]) ||
      resolveBoneName("mixamorig:Spine2", [name])
    ) {
      const d_tgt = computeSpineDirection(landmarks);
      if (d_tgt && bone.children.length > 0) {
        const child = bone.children[0];
        const childWorldPos = child.getWorldPosition(new THREE.Vector3());
        const boneWorldPos = bone.getWorldPosition(new THREE.Vector3());
        const d_cur = childWorldPos.sub(boneWorldPos).normalize();
        if (d_cur.lengthSq() > 0) {
          const q = computeRotation(d_cur, d_tgt);
          const parentWorldQ = bone.parent
            ? bone.parent.getWorldQuaternion(new THREE.Quaternion())
            : new THREE.Quaternion();
          const localQ = parentWorldQ.clone().invert().multiply(q).multiply(parentWorldQ);
          bone.quaternion.premultiply(localQ);
          bone.updateMatrixWorld(true);
        }
      }
      return;
    }

    // Neck / Head
    if (
      resolveBoneName("mixamorig:Neck", [name]) ||
      resolveBoneName("mixamorig:Head", [name])
    ) {
      const d_tgt = computeNeckDirection(landmarks);
      if (d_tgt && bone.children.length > 0) {
        const child = bone.children[0];
        const childWorldPos = child.getWorldPosition(new THREE.Vector3());
        const boneWorldPos = bone.getWorldPosition(new THREE.Vector3());
        const d_cur = childWorldPos.sub(boneWorldPos).normalize();
        if (d_cur.lengthSq() > 0) {
          const q = computeRotation(d_cur, d_tgt);
          const parentWorldQ = bone.parent
            ? bone.parent.getWorldQuaternion(new THREE.Quaternion())
            : new THREE.Quaternion();
          const localQ = parentWorldQ.clone().invert().multiply(q).multiply(parentWorldQ);
          bone.quaternion.premultiply(localQ);
          bone.updateMatrixWorld(true);
        }
      }
      return;
    }

    // Limbs
    const mixamoName = Object.keys(LIMB_BONE_MAPPINGS).find((k) =>
      resolveBoneName(k, [name])
    );
    if (mixamoName && bone.children.length > 0) {
      const mapping = LIMB_BONE_MAPPINGS[mixamoName];
      const d_tgt = computeDirection(
        landmarks[mapping.parentLm],
        landmarks[mapping.childLm]
      );
      if (d_tgt) {
        const child = bone.children[0];
        const childWorldPos = child.getWorldPosition(new THREE.Vector3());
        const boneWorldPos = bone.getWorldPosition(new THREE.Vector3());
        const d_cur = childWorldPos.sub(boneWorldPos).normalize();
        if (d_cur.lengthSq() > 0) {
          const q = computeRotation(d_cur, d_tgt);
          const parentWorldQ = bone.parent
            ? bone.parent.getWorldQuaternion(new THREE.Quaternion())
            : new THREE.Quaternion();
          const localQ = parentWorldQ.clone().invert().multiply(q).multiply(parentWorldQ);
          bone.quaternion.premultiply(localQ);
          bone.updateMatrixWorld(true);
        }
      }
    }
  });
};

export const computeFrontVector = (landmarks: RawLandmark[]): THREE.Vector3 => {
  const fallback = new THREE.Vector3(0, 0, 1);
  const ls = landmarks[LM.LEFT_SHOULDER];
  const rs = landmarks[LM.RIGHT_SHOULDER];
  const lh = landmarks[LM.LEFT_HIP];
  const rh = landmarks[LM.RIGHT_HIP];
  if (!ls || !rs || !lh || !rh) return fallback;

  const shoulderMid = toVec(ls).add(toVec(rs)).multiplyScalar(0.5);
  const hipMid = toVec(lh).add(toVec(rh)).multiplyScalar(0.5);

  const up = shoulderMid.clone().sub(hipMid);
  const right = toVec(rh).sub(toVec(lh));
  if (up.lengthSq() === 0 || right.lengthSq() === 0) return fallback;

  const front = up.cross(right);
  if (front.lengthSq() === 0) return fallback;
  return front.normalize();
};

export const getVertexMuscleId = (
  boneIndex: number,
  vertexWorldPos: THREE.Vector3,
  frontVec: THREE.Vector3,
  bones: THREE.Bone[]
): string | null => {
  if (boneIndex < 0 || boneIndex >= bones.length) return null;
  const bName = bones[boneIndex].name;
  const is = (mixamo: string) => resolveBoneName(mixamo, [bName]) !== undefined;

  if (is("mixamorig:Spine") || is("mixamorig:Spine1") || is("mixamorig:Spine2"))
    return "core";
  if (is("mixamorig:Hips")) return "glutes";

  if (is("mixamorig:LeftShoulder")) return "deltoid:L";
  if (is("mixamorig:RightShoulder")) return "deltoid:R";

  if (is("mixamorig:LeftArm")) return "biceps:L";
  if (is("mixamorig:RightArm")) return "biceps:R";

  if (is("mixamorig:LeftForeArm") || is("mixamorig:LeftHand")) return "forearm:L";
  if (is("mixamorig:RightForeArm") || is("mixamorig:RightHand")) return "forearm:R";

  if (is("mixamorig:LeftLeg") || is("mixamorig:LeftFoot") || is("mixamorig:LeftToeBase"))
    return "calf:L";
  if (
    is("mixamorig:RightLeg") ||
    is("mixamorig:RightFoot") ||
    is("mixamorig:RightToeBase")
  )
    return "calf:R";

  if (is("mixamorig:LeftUpLeg")) {
    const boneWorldPos = bones[boneIndex].getWorldPosition(new THREE.Vector3());
    const dir = vertexWorldPos.clone().sub(boneWorldPos);
    return dir.dot(frontVec) > 0 ? "quadriceps:L" : "hamstrings:L";
  }
  if (is("mixamorig:RightUpLeg")) {
    const boneWorldPos = bones[boneIndex].getWorldPosition(new THREE.Vector3());
    const dir = vertexWorldPos.clone().sub(boneWorldPos);
    return dir.dot(frontVec) > 0 ? "quadriceps:R" : "hamstrings:R";
  }

  return null;
};

export const applyMuscleHeatColors = (
  mesh: THREE.SkinnedMesh,
  activations: ActivationMap,
  landmarks: RawLandmark[],
  selectedMuscle?: string | null
) => {
  const geometry = mesh.geometry;
  const position = geometry.attributes.position;
  const skinIndex = geometry.attributes.skinIndex;
  const skinWeight = geometry.attributes.skinWeight;

  if (!geometry.attributes.color) {
    geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(position.count * 3), 3)
    );
  }
  const colors = geometry.attributes.color;
  const frontVec = computeFrontVector(landmarks);
  const bones = mesh.skeleton.bones;

  const vertexWorldPos = new THREE.Vector3();

  for (let i = 0; i < position.count; i++) {
    let maxWeight = -1;
    let mainBoneIndex = 0;
    for (let j = 0; j < 4; j++) {
      const w = skinWeight.getComponent(i, j);
      if (w > maxWeight) {
        maxWeight = w;
        mainBoneIndex = skinIndex.getComponent(i, j);
      }
    }

    const localPos = new THREE.Vector3().fromBufferAttribute(position, i);
    vertexWorldPos.copy(localPos).applyMatrix4(mesh.matrixWorld);

    const mId = getVertexMuscleId(mainBoneIndex, vertexWorldPos, frontVec, bones);

    let baseColor = new THREE.Color(NEUTRAL);

    if (mId) {
      const act = activations[mId] || 0;
      const hc = heatColor(act);
      baseColor = hc.color;

      const baseMuscleId = mId.split(":")[0];
      if (selectedMuscle && baseMuscleId !== selectedMuscle) {
        baseColor = new THREE.Color(NEUTRAL);
      }
    } else {
      if (selectedMuscle) {
        baseColor = new THREE.Color(NEUTRAL);
      }
    }

    colors.setXYZ(i, baseColor.r, baseColor.g, baseColor.b);
  }

  colors.needsUpdate = true;
};

export const musclesAtFace = (
  mesh: THREE.SkinnedMesh,
  faceIndex: number,
  landmarks: RawLandmark[]
): string[] => {
  const geometry = mesh.geometry;
  const index = geometry.index;
  if (!index) return [];

  const a = index.getX(faceIndex * 3);
  const b = index.getX(faceIndex * 3 + 1);
  const c = index.getX(faceIndex * 3 + 2);

  const frontVec = computeFrontVector(landmarks);
  const bones = mesh.skeleton.bones;

  const getMid = (vi: number) => {
    let maxWeight = -1;
    let mainBoneIndex = 0;
    for (let j = 0; j < 4; j++) {
      const w = geometry.attributes.skinWeight.getComponent(vi, j);
      if (w > maxWeight) {
        maxWeight = w;
        mainBoneIndex = geometry.attributes.skinIndex.getComponent(vi, j);
      }
    }
    const localPos = new THREE.Vector3().fromBufferAttribute(
      geometry.attributes.position,
      vi
    );
    const vertexWorldPos = localPos.clone().applyMatrix4(mesh.matrixWorld);
    return getVertexMuscleId(mainBoneIndex, vertexWorldPos, frontVec, bones);
  };

  const m1 = getMid(a);
  const m2 = getMid(b);
  const m3 = getMid(c);

  const set = new Set<string>();
  if (m1) set.add(m1.split(":")[0]);
  if (m2) set.add(m2.split(":")[0]);
  if (m3) set.add(m3.split(":")[0]);

  return Array.from(set);
};

export const computeSkeletonBoundingBox = (root: THREE.Object3D): THREE.Box3 => {
  const box = new THREE.Box3();
  root.traverse((obj) => {
    if ((obj as THREE.Bone).isBone) {
      box.expandByPoint(obj.getWorldPosition(new THREE.Vector3()));
    }
  });
  box.expandByScalar(0.15); // Add thickness
  return box;
};
