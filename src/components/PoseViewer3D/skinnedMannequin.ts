import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  resolveBoneName,
  computeSpineDirection,
  computeNeckDirection,
  computeDirection,
  LIMB_BONE_MAPPINGS,
  computeHipsRotation,
} from "./retarget";
import { heatColor } from "./muscles";
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

export const setupMannequinMaterials = (root: THREE.Object3D): void => {
  root.traverse((child) => {
    if (child instanceof THREE.SkinnedMesh) {
      child.material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.55,
        metalness: 0.05,
      });
      if (!child.geometry.hasAttribute("color")) {
        const positionAttribute = child.geometry.getAttribute("position");
        const colors = new Float32Array(positionAttribute.count * 3);
        const c = new THREE.Color(NEUTRAL);
        for (let i = 0; i < positionAttribute.count; i++) {
          colors[i * 3] = c.r;
          colors[i * 3 + 1] = c.g;
          colors[i * 3 + 2] = c.b;
        }
        child.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      }
    }
  });
};

export const computeSkeletonBoundingBox = (skeleton: THREE.Skeleton): THREE.Box3 => {
  const box = new THREE.Box3();
  for (const bone of skeleton.bones) {
    box.expandByPoint(bone.getWorldPosition(new THREE.Vector3()));
  }
  box.expandByScalar(0.15);
  return box;
};

export const applyPoseToSkeleton = (
  root: THREE.Object3D,
  landmarks: RawLandmark[]
): void => {
  const boneMap = new Map<string, THREE.Bone>();
  root.traverse((child) => {
    if ((child as THREE.Bone).isBone) {
      boneMap.set(child.name, child as THREE.Bone);
    }
  });

  const bones = Array.from(boneMap.values());
  const boneNames = bones.map((b) => b.name);

  const applyRotationToBone = (
    bone: THREE.Bone | undefined,
    targetDir: THREE.Vector3 | null
  ) => {
    if (!bone || !targetDir) return;
    bone.updateMatrixWorld(true);
    if (bone.children.length === 0) return;

    const child = bone.children[0];
    const bonePos = new THREE.Vector3();
    bone.getWorldPosition(bonePos);
    const childPos = new THREE.Vector3();
    child.getWorldPosition(childPos);

    const d_cur = childPos.sub(bonePos).normalize();
    const d_tgt = targetDir.clone().normalize();
    if (d_cur.lengthSq() === 0 || d_tgt.lengthSq() === 0) return;

    const q = new THREE.Quaternion().setFromUnitVectors(d_cur, d_tgt);

    const parentWorldQ = bone.parent
      ? bone.parent.getWorldQuaternion(new THREE.Quaternion())
      : new THREE.Quaternion();

    const localDelta = parentWorldQ.clone().invert().multiply(q).multiply(parentWorldQ);
    bone.quaternion.premultiply(localDelta);
    bone.updateMatrixWorld(true);
  };

  const hipsName = resolveBoneName("mixamorig:Hips", boneNames);
  if (hipsName) {
    const hips = boneMap.get(hipsName);
    const q = computeHipsRotation(landmarks);
    if (hips && q) {
      const parentQ = hips.parent
        ? hips.parent.getWorldQuaternion(new THREE.Quaternion())
        : new THREE.Quaternion();
      hips.quaternion.copy(parentQ.clone().invert().multiply(q));
      hips.updateMatrixWorld(true);
    }
  }

  const spineName = resolveBoneName("mixamorig:Spine", boneNames);
  if (spineName) {
    const spine = boneMap.get(spineName);
    const spineDir = computeSpineDirection(landmarks);
    applyRotationToBone(spine, spineDir);
  }

  const neckName = resolveBoneName("mixamorig:Neck", boneNames);
  if (neckName) {
    const neck = boneMap.get(neckName);
    const neckDir = computeNeckDirection(landmarks);
    applyRotationToBone(neck, neckDir);
  }

  const limbOrder = [
    "mixamorig:LeftUpLeg",
    "mixamorig:LeftLeg",
    "mixamorig:LeftFoot",
    "mixamorig:RightUpLeg",
    "mixamorig:RightLeg",
    "mixamorig:RightFoot",
    "mixamorig:LeftArm",
    "mixamorig:LeftForeArm",
    "mixamorig:RightArm",
    "mixamorig:RightForeArm",
  ];

  for (const mixamoName of limbOrder) {
    const mapping = LIMB_BONE_MAPPINGS[mixamoName];
    if (!mapping) continue;
    const name = resolveBoneName(mixamoName, boneNames);
    if (!name) continue;
    const bone = boneMap.get(name);
    const dir = computeDirection(landmarks[mapping.parentLm], landmarks[mapping.childLm]);
    applyRotationToBone(bone, dir);
  }
};

export const getVertexMuscleId = (
  vertexIndex: number,
  geometry: THREE.BufferGeometry,
  skeleton: THREE.Skeleton
): string | null => {
  const skinIndexAttr = geometry.getAttribute("skinIndex");
  const skinWeightAttr = geometry.getAttribute("skinWeight");
  if (!skinIndexAttr || !skinWeightAttr) return null;

  let maxWeight = 0;
  let dominantBoneIndex = 0;
  for (let i = 0; i < 4; i++) {
    const weight = skinWeightAttr.getComponent(vertexIndex, i);
    if (weight > maxWeight) {
      maxWeight = weight;
      dominantBoneIndex = skinIndexAttr.getComponent(vertexIndex, i);
    }
  }

  const bone = skeleton.bones[dominantBoneIndex];
  if (!bone) return null;

  const boneName = bone.name;
  const isLeft = boneName.toLowerCase().includes("left");

  if (boneName.includes("Hips")) {
    const positionAttr = geometry.getAttribute("position");
    const localPos = new THREE.Vector3().fromBufferAttribute(positionAttr, vertexIndex);
    const boneBindMatrix = skeleton.boneInverses[dominantBoneIndex].clone().invert();
    const boneBindPos = new THREE.Vector3().setFromMatrixPosition(boneBindMatrix);
    const dir = localPos.clone().sub(boneBindPos);
    return dir.x > 0 ? "glutes:L" : "glutes:R";
  }

  if (boneName.includes("Spine")) return "core";
  if (boneName.includes("Neck") || boneName.includes("Head") || boneName.includes("Eye"))
    return null;

  const side = isLeft ? "L" : "R";

  if (boneName.includes("ForeArm") || boneName.includes("Hand")) return `forearm:${side}`;
  if (boneName.includes("Arm")) return `biceps:${side}`;
  if (boneName.includes("Shoulder")) return `deltoid:${side}`;

  if (boneName.includes("UpLeg")) {
    const positionAttr = geometry.getAttribute("position");
    const localPos = new THREE.Vector3().fromBufferAttribute(positionAttr, vertexIndex);
    const boneBindMatrix = skeleton.boneInverses[dominantBoneIndex].clone().invert();
    const boneBindPos = new THREE.Vector3().setFromMatrixPosition(boneBindMatrix);
    const dir = localPos.clone().sub(boneBindPos);

    if (dir.z > 0) {
      return `quadriceps:${side}`;
    } else {
      return `hamstrings:${side}`;
    }
  }

  if (
    boneName.includes("Leg") ||
    boneName.includes("Foot") ||
    boneName.includes("ToeBase")
  )
    return `calf:${side}`;

  return null;
};

export const applyMuscleHeatColors = (
  mesh: THREE.SkinnedMesh,
  activations: ActivationMap,
  selectedMuscle?: string
): void => {
  const geometry = mesh.geometry;
  const skeleton = mesh.skeleton;
  if (!skeleton || !geometry.getAttribute("position")) return;

  if (!geometry.getAttribute("color")) {
    const positionAttr = geometry.getAttribute("position");
    const colors = new Float32Array(positionAttr.count * 3);
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  }
  const colorAttr = geometry.getAttribute("color") as THREE.BufferAttribute;

  const neutralColor = new THREE.Color(NEUTRAL);

  for (let i = 0; i < colorAttr.count; i++) {
    const muscleId = getVertexMuscleId(i, geometry, skeleton);

    let color = neutralColor;
    if (muscleId && activations[muscleId]) {
      const hc = heatColor(activations[muscleId]);
      const activeColor = hc.color;
      if (!selectedMuscle || muscleId.startsWith(selectedMuscle)) {
        color = activeColor;
      }
    }

    colorAttr.setXYZ(i, color.r, color.g, color.b);
  }
  colorAttr.needsUpdate = true;
};

export const musclesAtFace = (mesh: THREE.SkinnedMesh, faceIndex: number): string[] => {
  const geometry = mesh.geometry;
  const indexAttr = geometry.getIndex();
  if (!indexAttr || !mesh.skeleton) return [];

  const a = indexAttr.getX(faceIndex * 3);
  const b = indexAttr.getX(faceIndex * 3 + 1);
  const c = indexAttr.getX(faceIndex * 3 + 2);

  const muscles = new Set<string>();
  for (const idx of [a, b, c]) {
    const m = getVertexMuscleId(idx, geometry, mesh.skeleton);
    if (m) muscles.add(m.split(":")[0]);
  }

  return Array.from(muscles);
};

export { computeHipsRotation };
