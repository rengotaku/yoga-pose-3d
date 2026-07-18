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
  canonicalizeBoneName,
  computeLowestPointY,
  groundMannequin,
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
    expect(mesh.material.onBeforeCompile).toBeDefined();
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

describe("getVertexMuscleId with human-base aliases", () => {
  it("resolves correct muscle for human-base bone names", () => {
    const mesh = createMockSkinnedMesh();
    mesh.skeleton!.bones[1].name = "thigh_l";

    const id0 = getVertexMuscleId(0, mesh.geometry, mesh.skeleton!);
    const id1 = getVertexMuscleId(1, mesh.geometry, mesh.skeleton!);

    expect(id0).toBe("quadriceps:L");
    expect(id1).toBe("hamstrings:L");

    mesh.skeleton!.bones[1].name = "thigh_r";
    const id2 = getVertexMuscleId(0, mesh.geometry, mesh.skeleton!);
    const id3 = getVertexMuscleId(1, mesh.geometry, mesh.skeleton!);
    expect(id2).toBe("quadriceps:R");
    expect(id3).toBe("hamstrings:R");
  });
});

describe("canonicalizeBoneName", () => {
  it("returns canonical mixamo name for human-base aliases", () => {
    expect(canonicalizeBoneName("pelvis")).toBe("Hips");
    expect(canonicalizeBoneName("spine_01")).toBe("Spine");
    expect(canonicalizeBoneName("upperarm_l")).toBe("LeftArm");
    expect(canonicalizeBoneName("thigh_r")).toBe("RightUpLeg");
  });

  it("returns original name if no alias matches", () => {
    expect(canonicalizeBoneName("mixamorigHips")).toBe("mixamorigHips");
    expect(canonicalizeBoneName("HeadTop_End")).toBe("HeadTop_End");
    expect(canonicalizeBoneName("head_leaf")).toBe("head_leaf");
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
    const emissionAttr = mesh.geometry.getAttribute("emissionIntensity");
    expect(colorAttr).toBeDefined();
    expect(emissionAttr).toBeDefined();

    // quadriceps is selected (index 0).
    const r0 = colorAttr.getX(0);
    const r1 = colorAttr.getX(1);

    expect(r0).not.toBe(new THREE.Color(0xb98a7a).r); // not neutral
    expect(r1).toBeCloseTo(new THREE.Color(0xb98a7a).r, 2); // neutral

    // selected muscle should have emission = 1.0, non-selected = 0.0
    expect(emissionAttr!.getX(0)).toBe(1.0);
    expect(emissionAttr!.getX(1)).toBe(0.0);
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

describe("computeLowestPointY", () => {
  it("returns the lowest skinned vertex Y in world space", () => {
    const mesh = createMockSkinnedMesh();
    const root = new THREE.Group();
    root.add(mesh.skeleton!.bones[0]);
    root.add(mesh);
    root.position.y = 2;
    root.updateMatrixWorld(true);
    // 両頂点とも y=0 → root オフセット分で world 最小 Y は 2
    expect(computeLowestPointY(root)).toBeCloseTo(2);
  });

  it("reflects bone deformation (skinned position, not bind pose)", () => {
    const mesh = createMockSkinnedMesh();
    const root = new THREE.Group();
    root.add(mesh.skeleton!.bones[0]);
    root.add(mesh);
    // vertex0 は bone[1] に 100% スキン → bone[1] を下げると最下点も下がる
    mesh.skeleton!.bones[1].position.set(0, -0.5, 0);
    root.updateMatrixWorld(true);
    expect(computeLowestPointY(root)).toBeCloseTo(-0.5);
  });

  it("returns null when there is no skinned mesh", () => {
    expect(computeLowestPointY(new THREE.Group())).toBeNull();
  });

  it("skips skinned meshes without skin attributes", () => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
    const mesh = new THREE.SkinnedMesh(geom, new THREE.MeshBasicMaterial());
    const root = new THREE.Group();
    root.add(mesh);
    expect(computeLowestPointY(root)).toBeNull();
  });
});

describe("groundMannequin", () => {
  it("snaps the lowest point to the floor and is idempotent", () => {
    const mesh = createMockSkinnedMesh();
    const root = new THREE.Group();
    root.add(mesh.skeleton!.bones[0]);
    root.add(mesh);
    mesh.skeleton!.bones[1].position.set(0, -0.5, 0);

    groundMannequin(root, -1);
    expect(computeLowestPointY(root)).toBeCloseTo(-1);
    expect(root.position.y).toBeCloseTo(-0.5);

    // 再適用しても累積せず同じ結果になる
    groundMannequin(root, -1);
    expect(computeLowestPointY(root)).toBeCloseTo(-1);
    expect(root.position.y).toBeCloseTo(-0.5);
  });

  it("resets the offset to origin when there is no skinned mesh", () => {
    const root = new THREE.Group();
    root.position.y = 5;
    groundMannequin(root, -1);
    expect(root.position.y).toBe(0);
  });
});
