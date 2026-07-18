import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  resolveBoneName,
  computeRotation,
  computeSpineDirection,
  computeNeckDirection,
  computeDirection,
  LIMB_BONE_MAPPINGS,
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

  const hipsName = resolveBoneName("mixamorig:Hips", boneNames);
  if (hipsName) {
    const hips = boneMap.get(hipsName);
    const q = computeHipsRotation(landmarks);
    if (hips && q) {
      const parentQ = hips.parent
        ? hips.parent.getWorldQuaternion(new THREE.Quaternion())
        : new THREE.Quaternion();
      hips.quaternion.copy(parentQ.clone().invert().multiply(q));
    }
  }

  const spineName = resolveBoneName("mixamorig:Spine", boneNames);
  if (spineName) {
    const spine = boneMap.get(spineName);
    const spineDir = computeSpineDirection(landmarks);
    if (spine && spineDir) {
      const parentWorldQ = spine.parent
        ? spine.parent.getWorldQuaternion(new THREE.Quaternion())
        : new THREE.Quaternion();
      const currentWorldDir = new THREE.Vector3(0, 1, 0).applyQuaternion(parentWorldQ);
      const q = computeRotation(currentWorldDir, spineDir);
      spine.quaternion.premultiply(q);
    }
  }

  const neckName = resolveBoneName("mixamorig:Neck", boneNames);
  if (neckName) {
    const neck = boneMap.get(neckName);
    const neckDir = computeNeckDirection(landmarks);
    if (neck && neckDir) {
      const parentWorldQ = neck.parent
        ? neck.parent.getWorldQuaternion(new THREE.Quaternion())
        : new THREE.Quaternion();
      const currentWorldDir = new THREE.Vector3(0, 1, 0).applyQuaternion(parentWorldQ);
      const q = computeRotation(currentWorldDir, neckDir);
      neck.quaternion.premultiply(q);
    }
  }

  for (const [mixamoName, mapping] of Object.entries(LIMB_BONE_MAPPINGS)) {
    const name = resolveBoneName(mixamoName, boneNames);
    if (!name) continue;
    const bone = boneMap.get(name);
    if (!bone) continue;

    const dir = computeDirection(landmarks[mapping.parentLm], landmarks[mapping.childLm]);
    if (!dir) continue;

    const parentWorldQ = bone.parent
      ? bone.parent.getWorldQuaternion(new THREE.Quaternion())
      : new THREE.Quaternion();
    const currentWorldDir = new THREE.Vector3(0, 1, 0).applyQuaternion(parentWorldQ);
    const q = computeRotation(currentWorldDir, dir);
    bone.quaternion.premultiply(q);
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
  const side = isLeft ? "L" : "R";

  if (boneName.includes("Arm")) return `biceps:${side}`;
  if (boneName.includes("ForeArm")) return `forearms:${side}`;

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

  if (boneName.includes("Leg")) return `calves:${side}`;
  if (boneName.includes("Foot")) return `calves:${side}`;

  if (boneName.includes("Hips") || boneName.includes("Spine")) return "core";
  if (boneName.includes("Neck") || boneName.includes("Head")) return "shoulders";
  if (boneName.includes("Shoulder")) return "shoulders";

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

// Re-export computeHipsRotation for tests and internal usage if needed
import { computeHipsRotation } from "./retarget";
export { computeHipsRotation };
