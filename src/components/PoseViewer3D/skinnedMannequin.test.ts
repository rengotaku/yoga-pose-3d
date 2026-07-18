import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { LM } from "./muscles";
import type { RawLandmark } from "./muscles";
import {
  applyPoseToSkeleton,
  computeFrontVector,
  getVertexMuscleId,
  applyMuscleHeatColors,
  musclesAtFace,
  computeSkeletonBoundingBox,
} from "./skinnedMannequin";

const buildMockLandmarks = (): RawLandmark[] => {
  const lm: RawLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
  lm[LM.NOSE] = { x: 0, y: -0.75, z: 0 };
  lm[LM.LEFT_SHOULDER] = { x: 0.18, y: -0.5, z: 0 };
  lm[LM.RIGHT_SHOULDER] = { x: -0.18, y: -0.5, z: 0 };
  lm[LM.LEFT_ELBOW] = { x: 0.2, y: -0.25, z: 0 };
  lm[LM.RIGHT_ELBOW] = { x: -0.2, y: -0.25, z: 0 };
  lm[LM.LEFT_WRIST] = { x: 0.22, y: 0.0, z: 0 };
  lm[LM.RIGHT_WRIST] = { x: -0.22, y: 0.0, z: 0 };
  lm[LM.LEFT_HIP] = { x: 0.1, y: 0.0, z: 0 };
  lm[LM.RIGHT_HIP] = { x: -0.1, y: 0.0, z: 0 };
  lm[LM.LEFT_KNEE] = { x: 0.1, y: 0.45, z: 0 };
  lm[LM.RIGHT_KNEE] = { x: -0.1, y: 0.45, z: 0 };
  lm[LM.LEFT_ANKLE] = { x: 0.1, y: 0.9, z: 0 };
  lm[LM.RIGHT_ANKLE] = { x: -0.1, y: 0.9, z: 0 };
  lm[LM.LEFT_FOOT_INDEX] = { x: 0.1, y: 0.95, z: -0.15 };
  lm[LM.RIGHT_FOOT_INDEX] = { x: -0.1, y: 0.95, z: -0.15 };
  return lm;
};

const createMockSkinnedMesh = (): THREE.SkinnedMesh => {
  const geometry = new THREE.BufferGeometry();
  // 3 vertices
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3)
  );
  geometry.setAttribute(
    "skinIndex",
    new THREE.BufferAttribute(new Uint16Array([0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0]), 4)
  );
  geometry.setAttribute(
    "skinWeight",
    new THREE.BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4)
  );
  geometry.setIndex([0, 1, 2]);

  const b0 = new THREE.Bone();
  b0.name = "mixamorig:Hips";
  const b1 = new THREE.Bone();
  b1.name = "mixamorig:LeftUpLeg";
  const b2 = new THREE.Bone();
  b2.name = "mixamorig:RightArm";

  b0.add(b1);
  b0.add(b2);

  const skeleton = new THREE.Skeleton([b0, b1, b2]);
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
  mesh.bind(skeleton);
  mesh.add(b0); // add root bone to mesh

  return mesh;
};

describe("computeFrontVector", () => {
  it("computes approximate front vector (-Z in three.js)", () => {
    const landmarks = buildMockLandmarks();
    const front = computeFrontVector(landmarks);
    // front should be pointing +Z or -Z depending on the definition,
    // with our landmarks, shoulders and hips are at z=0, y varies, x varies.
    // up is (0, 0.5, 0) in three, right is (-0.2, 0, 0)
    // up x right = (0, 0, 0.1) -> normalize -> (0, 0, 1) (+z)
    expect(front.x).toBeCloseTo(0);
    expect(front.y).toBeCloseTo(0);
    expect(front.z).toBeCloseTo(1);
  });
});

describe("getVertexMuscleId", () => {
  it("resolves correct muscle for given bone and front vector", () => {
    const b0 = new THREE.Bone();
    b0.name = "mixamorig:Hips";
    const b1 = new THREE.Bone();
    b1.name = "mixamorig:LeftUpLeg";

    b1.position.set(0, -1, 0);
    b0.add(b1);
    b0.updateMatrixWorld(true);

    const bones = [b0, b1];
    const frontVec = new THREE.Vector3(0, 0, 1);

    // Test Hips -> glutes
    expect(getVertexMuscleId(0, new THREE.Vector3(0, 0, 0), frontVec, bones)).toBe(
      "glutes"
    );

    // Test LeftUpLeg -> quadriceps (front)
    expect(getVertexMuscleId(1, new THREE.Vector3(0, -1, 1), frontVec, bones)).toBe(
      "quadriceps:L"
    );

    // Test LeftUpLeg -> hamstrings (back)
    expect(getVertexMuscleId(1, new THREE.Vector3(0, -1, -1), frontVec, bones)).toBe(
      "hamstrings:L"
    );
  });
});

describe("applyMuscleHeatColors", () => {
  it("applies colors and handles selectedMuscle dimming", () => {
    const mesh = createMockSkinnedMesh();
    const landmarks = buildMockLandmarks();
    const activations = { glutes: 1, "quadriceps:L": 0.5 };

    // selected = glutes
    applyMuscleHeatColors(mesh, activations, landmarks, "glutes");

    const colorAttr = mesh.geometry.attributes.color as THREE.BufferAttribute;
    expect(colorAttr).toBeDefined();

    // Hips (index 0) should be colored (not neutral)
    const r0 = colorAttr.getX(0);

    // LeftUpLeg (index 1) should be neutral because it is not selected
    const r1 = colorAttr.getX(1);

    expect(r0).not.toBe(new THREE.Color(0xb98a7a).r); // not neutral
    expect(r1).toBeCloseTo(new THREE.Color(0xb98a7a).r, 2); // neutral
  });
});

describe("musclesAtFace", () => {
  it("returns unique muscle groups for a given face", () => {
    const mesh = createMockSkinnedMesh();
    const landmarks = buildMockLandmarks();

    const muscles = musclesAtFace(mesh, 0, landmarks);

    // The face uses vertices 0, 1, 2 which map to bones Hips, LeftUpLeg, RightArm.
    // Hips -> glutes
    // LeftUpLeg (at 1,0,0, front=(0,0,1)) dot(1,0,0 * 0,0,1) = 0 -> hamstrings
    // RightArm -> biceps
    expect(muscles).toContain("glutes");
    expect(muscles).toContain("biceps");
  });
});

describe("computeSkeletonBoundingBox", () => {
  it("computes bbox covering bones", () => {
    const mesh = createMockSkinnedMesh();
    // b0 is at 0,0,0
    // b1 is at 0,0,0
    // but lets move them
    mesh.skeleton.bones[1].position.set(1, 1, 1);
    mesh.skeleton.bones[1].updateMatrixWorld(true);

    const bbox = computeSkeletonBoundingBox(mesh);
    expect(bbox.min.x).toBeLessThan(0);
    expect(bbox.max.x).toBeGreaterThan(1);
  });
});

describe("applyPoseToSkeleton", () => {
  it("does not throw and processes traverse", () => {
    const mesh = createMockSkinnedMesh();
    const landmarks = buildMockLandmarks();

    expect(() => applyPoseToSkeleton(mesh, landmarks)).not.toThrow();
  });
});
