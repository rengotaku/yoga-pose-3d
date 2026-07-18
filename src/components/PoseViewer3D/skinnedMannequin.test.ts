import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { LM } from "./muscles";
import type { RawLandmark } from "./muscles";
import {
  applyPoseToSkeleton,
  getVertexMuscleId,
  applyMuscleHeatColors,
  musclesAtFace,
  computeSkeletonBoundingBox,
  setupMannequinMaterials,
} from "./skinnedMannequin";
import { MUSCLE_ORDER } from "./muscles";

const buildMockLandmarks = (): RawLandmark[] => {
  const lm: RawLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
  lm[LM.LEFT_HIP] = { x: 0.1, y: 0, z: 0 };
  lm[LM.RIGHT_HIP] = { x: -0.1, y: 0, z: 0 };
  lm[LM.LEFT_SHOULDER] = { x: 0.2, y: -0.5, z: 0 };
  lm[LM.RIGHT_SHOULDER] = { x: -0.2, y: -0.5, z: 0 };
  lm[LM.LEFT_KNEE] = { x: 0.1, y: 0.4, z: 0 };
  return lm;
};

const createMockSkinnedMesh = () => {
  const geom = new THREE.BufferGeometry();
  // Provide positions for front (+z) and back (-z)
  geom.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([
        0,
        0,
        1, // index 0: front
        0,
        0,
        -1, // index 1: back
      ]),
      3
    )
  );
  geom.setAttribute(
    "skinIndex",
    new THREE.BufferAttribute(new Uint16Array([1, 0, 0, 0, 1, 0, 0, 0]), 4)
  );
  geom.setAttribute(
    "skinWeight",
    new THREE.BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0]), 4)
  );
  geom.setIndex([0, 1, 0]);

  const boneHips = new THREE.Bone();
  boneHips.name = "mixamorig:Hips";
  const boneUpLeg = new THREE.Bone();
  boneUpLeg.name = "mixamorig:LeftUpLeg";
  boneHips.add(boneUpLeg);

  const skeleton = new THREE.Skeleton([boneHips, boneUpLeg]);
  skeleton.boneInverses = [new THREE.Matrix4(), new THREE.Matrix4()];

  const mesh = new THREE.SkinnedMesh(geom, new THREE.MeshBasicMaterial());
  mesh.bind(skeleton);
  return mesh;
};

describe("setupMannequinMaterials", () => {
  it("sets up materials with vertex colors and neutral color attribute", () => {
    const mesh = createMockSkinnedMesh();
    setupMannequinMaterials(mesh);
    expect(mesh.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect((mesh.material as unknown as THREE.MeshStandardMaterial).vertexColors).toBe(
      true
    );
    expect(mesh.geometry.hasAttribute("color")).toBe(true);
  });
});

describe("applyPoseToSkeleton", () => {
  it("does not throw and processes traverse", () => {
    const root = new THREE.Group();
    const mesh = createMockSkinnedMesh();
    root.add(mesh);
    expect(() => applyPoseToSkeleton(root, buildMockLandmarks())).not.toThrow();
  });
});

describe("getVertexMuscleId", () => {
  it("resolves correct muscle for given bone and front vector", () => {
    const mesh = createMockSkinnedMesh();
    const id0 = getVertexMuscleId(0, mesh.geometry, mesh.skeleton!);
    const id1 = getVertexMuscleId(1, mesh.geometry, mesh.skeleton!);

    expect(id0).toBe("quadriceps:L");
    expect(id1).toBe("hamstrings:L");
    expect(MUSCLE_ORDER).toContain(id0?.split(":")[0]);
    expect(MUSCLE_ORDER).toContain(id1?.split(":")[0]);
  });
});

describe("applyMuscleHeatColors", () => {
  it("applies colors and handles selectedMuscle dimming", () => {
    const mesh = createMockSkinnedMesh();
    applyMuscleHeatColors(
      mesh,
      { "quadriceps:L": 1.0, "hamstrings:L": 0.5 },
      "quadriceps"
    );

    const colorAttr = mesh.geometry.getAttribute("color");
    expect(colorAttr).toBeDefined();

    // quadriceps is selected (index 0).
    const r0 = colorAttr.getX(0);
    const r1 = colorAttr.getX(1);

    expect(r0).not.toBe(new THREE.Color(0xb98a7a).r); // not neutral
    expect(r1).toBeCloseTo(new THREE.Color(0xb98a7a).r, 2); // neutral
  });
});

describe("musclesAtFace", () => {
  it("returns unique muscle groups for a given face", () => {
    const mesh = createMockSkinnedMesh();
    const muscles = musclesAtFace(mesh, 0);
    expect(muscles).toContain("quadriceps");
    expect(muscles).toContain("hamstrings");
    for (const m of muscles) {
      expect(MUSCLE_ORDER).toContain(m as (typeof MUSCLE_ORDER)[number]);
    }
  });
});

describe("computeSkeletonBoundingBox", () => {
  it("computes bbox covering bones", () => {
    const mesh = createMockSkinnedMesh();
    mesh.skeleton!.bones[1].position.set(10, 10, 10);
    // Needs updateMatrixWorld to apply position
    mesh.skeleton!.bones[0].updateMatrixWorld(true);
    const box = computeSkeletonBoundingBox(mesh.skeleton!);
    expect(box.max.x).toBeCloseTo(10.15);
  });
});
