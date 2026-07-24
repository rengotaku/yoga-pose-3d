import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, screen } from "@testing-library/react";
import * as THREE from "three";

vi.mock("three", async (importOriginal) => {
  const mod = await importOriginal<typeof import("three")>();
  return {
    ...mod,
    WebGLRenderer: class {
      setSize = vi.fn();
      setPixelRatio = vi.fn();
      render = vi.fn();
      dispose = vi.fn();
      domElement = document.createElement("canvas");
      shadowMap = { enabled: false, type: 0 };
    },
  };
});
import { PoseViewer3D } from "./PoseViewer3D";
import { usePoseStore } from "../../store/usePoseStore";
import { MuscleLegend, type MuscleActivation } from "./MuscleLegend";
import { calculateCameraFit } from "./cameraFit";
import {
  angleAt,
  flexion,
  computeActivations,
  detectSupportLegs,
  aggregateByMuscle,
  heatColor,
  MUSCLE_ORDER,
  LM,
  type RawLandmark,
} from "./muscles";
import * as skinnedMannequin from "./skinnedMannequin";

// 立位（腕を横、脚をまっすぐ）に近い最小限のランドマーク集合。
const buildStanding = (): RawLandmark[] => {
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

const buildTreePose = (): RawLandmark[] => {
  const lm = buildStanding();
  const hipL = lm[LM.LEFT_HIP];
  const dir = { x: 0.248, y: 0.62, z: -0.744 };
  lm[LM.LEFT_KNEE] = {
    x: hipL.x + 0.45 * dir.x,
    y: hipL.y + 0.45 * dir.y,
    z: hipL.z + 0.45 * dir.z,
  };
  lm[LM.LEFT_ANKLE] = {
    x: hipL.x + 0.9 * dir.x,
    y: hipL.y + 0.9 * dir.y,
    z: hipL.z + 0.9 * dir.z,
  };
  lm[LM.LEFT_FOOT_INDEX] = {
    x: hipL.x + 1.0 * dir.x,
    y: hipL.y + 1.0 * dir.y,
    z: hipL.z + 1.0 * dir.z,
  };
  return lm;
};

describe("angleAt", () => {
  it("returns ~PI for collinear points (straight limb)", () => {
    expect(
      angleAt({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 })
    ).toBeCloseTo(Math.PI);
  });
  it("returns ~PI/2 for a right angle", () => {
    expect(
      angleAt({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })
    ).toBeCloseTo(Math.PI / 2);
  });
  it("falls back to PI when a landmark is missing", () => {
    expect(angleAt(undefined, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBe(Math.PI);
  });
});

describe("flexion", () => {
  it("maps straight(180°)->0, right angle->0.5, full flex(0°)->1", () => {
    expect(flexion(Math.PI)).toBeCloseTo(0);
    expect(flexion(Math.PI / 2)).toBeCloseTo(0.5);
    expect(flexion(0)).toBeCloseTo(1);
  });
});

describe("heatColor", () => {
  it("returns a THREE.Color and emissive scaling with activation", () => {
    const low = heatColor(0);
    const high = heatColor(1);
    expect(low.color).toBeInstanceOf(THREE.Color);
    expect(high.emissiveIntensity).toBeGreaterThan(low.emissiveIntensity);
  });
});

describe("computeActivations", () => {
  it("bent elbow raises biceps activation above a straight elbow", () => {
    const straight = buildStanding();
    const bent = buildStanding();
    bent[LM.LEFT_WRIST] = { x: 0.18, y: -0.45, z: -0.1 };
    expect(computeActivations(bent)["biceps:L"]).toBeGreaterThan(
      computeActivations(straight)["biceps:L"]
    );
  });
  it("bent knee raises quadriceps activation", () => {
    const straight = buildStanding();
    const squat = buildStanding();
    squat[LM.LEFT_ANKLE] = { x: 0.1, y: 0.7, z: -0.35 };
    expect(computeActivations(squat)["quadriceps:L"]).toBeGreaterThan(
      computeActivations(straight)["quadriceps:L"]
    );
  });
  it("all activations are within [0,1]", () => {
    const act = computeActivations(buildStanding());
    Object.values(act).forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    });
  });
  it("one-leg stance (tree pose): support leg side quadriceps/calf are higher than the lifted leg side", () => {
    const act = computeActivations(buildTreePose());
    expect(act["quadriceps:R"]).toBeGreaterThan(act["quadriceps:L"]);
    expect(act["calf:R"]).toBeGreaterThan(act["calf:L"]);
  });
  it("two-leg stance: left/right quadriceps and calf are roughly equal", () => {
    const act = computeActivations(buildStanding());
    expect(act["quadriceps:L"]).toBeCloseTo(act["quadriceps:R"], 5);
    expect(act["calf:L"]).toBeCloseTo(act["calf:R"], 5);
  });
});

describe("detectSupportLegs", () => {
  it("returns roughly equal load for a symmetric two-leg stance", () => {
    const support = detectSupportLegs(buildStanding());
    expect(support.L).toBeCloseTo(support.R, 5);
    expect(support.L).toBeGreaterThan(0);
  });
  it("returns a much lower load for the lifted leg in a one-leg stance", () => {
    const support = detectSupportLegs(buildTreePose());
    expect(support.R).toBeGreaterThan(support.L);
    expect(support.L).toBeCloseTo(0, 5);
  });
});

describe("aggregateByMuscle", () => {
  it("returns one entry per muscle group in defined order", () => {
    const list = aggregateByMuscle(computeActivations(buildStanding()));
    expect(list.map((m) => m.id)).toEqual(MUSCLE_ORDER);
    list.forEach((m) => {
      expect(m.value).toBeGreaterThanOrEqual(0);
      expect(m.value).toBeLessThanOrEqual(1);
    });
  });
});

describe("calculateCameraFit", () => {
  it("calculates correct camera position and target for a given bounding box", () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const result = calculateCameraFit(box, 45, 1.3);
    expect(result.target.x).toBeCloseTo(0);
    expect(result.target.y).toBeCloseTo(0);
    expect(result.target.z).toBeCloseTo(0);

    // bbox 縦横フィット: 縦横 2、margin 1.3、aspect 1 → distV = distH = 1.3 / tan(22.5°)
    const fovRad = (45 * Math.PI) / 180;
    const tanHalfV = Math.tan(fovRad / 2);
    const expectedDistance = (2 * 1.3) / 2 / tanHalfV + 1; // + 奥行き半分 (size.z / 2 = 1)
    expect(result.position.z).toBeCloseTo(expectedDistance);
    expect(result.position.x).toBeCloseTo(0);
    expect(result.position.y).toBeCloseTo(0);
  });
  it("uses the horizontal fov for wide boxes (aspect-aware)", () => {
    // 横長 bbox (幅6, 高さ2, 奥行き2)、aspect 2 → tanHalfH = 2 * tanHalfV
    const box = new THREE.Box3(new THREE.Vector3(-3, -1, -1), new THREE.Vector3(3, 1, 1));
    const result = calculateCameraFit(box, 45, 1.0, 2);
    const tanHalfV = Math.tan((45 * Math.PI) / 180 / 2);
    const distV = 2 / 2 / tanHalfV;
    const distH = 6 / 2 / (tanHalfV * 2);
    expect(distH).toBeGreaterThan(distV);
    expect(result.position.z).toBeCloseTo(distH + 1);
  });
  it("handles an empty bounding box", () => {
    const box = new THREE.Box3();
    const result = calculateCameraFit(box, 45, 1.3);
    expect(result.target.x).toBe(0);
    expect(result.target.y).toBe(0);
    expect(result.target.z).toBe(0);
    expect(result.position.x).toBe(0);
    expect(result.position.y).toBe(1);
    expect(result.position.z).toBe(3);
  });
});

describe("MuscleLegend", () => {
  it("calls onSelectMuscle when a muscle row is clicked", () => {
    const activations: MuscleActivation[] = [
      { id: "biceps", label: "上腕", value: 0.8 },
      { id: "core", label: "体幹", value: 0.5 },
    ];
    let selected: string | null = null;
    const { getByText } = render(
      <MuscleLegend
        activations={activations}
        selectedMuscle={null}
        onSelectMuscle={(id) => {
          selected = id;
        }}
      />
    );
    fireEvent.click(getByText("上腕"));
    expect(selected).toBe("biceps");
  });
  it("toggles off when the selected muscle is clicked again", () => {
    const activations: MuscleActivation[] = [{ id: "biceps", label: "上腕", value: 0.8 }];
    let selected: string | null = "biceps";
    const { getByText } = render(
      <MuscleLegend
        activations={activations}
        selectedMuscle="biceps"
        onSelectMuscle={(id) => {
          selected = id;
        }}
      />
    );
    fireEvent.click(getByText("上腕"));
    expect(selected).toBeNull();
  });
});

vi.mock("../../store/usePoseStore", () => ({
  usePoseStore: vi.fn(),
}));

vi.mock("./skinnedMannequin", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./skinnedMannequin")>();
  return {
    ...mod,
    loadMannequin: vi.fn(),
  };
});

describe("PoseViewer3D UI & Logic integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePoseStore).mockReturnValue(null);
    vi.mocked(skinnedMannequin.loadMannequin).mockResolvedValue(new THREE.Group());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders placeholder when no landmarks are present", async () => {
    render(<PoseViewer3D />);
    await waitFor(() => {
      expect(
        screen.getByText(/画像をアップロードすると3Dモデルが表示されます/)
      ).toBeDefined();
    });
  });

  it("loads mannequin and applies poses when landmarks are provided", async () => {
    vi.mocked(usePoseStore).mockReturnValue(buildStanding());
    const mockGroup = new THREE.Group();
    // mock a skinned mesh with a skeleton to pass camera fit and traverse
    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3)
    );
    const mesh = new THREE.SkinnedMesh(geom, new THREE.MeshBasicMaterial());
    const bone = new THREE.Bone();
    mesh.bind(new THREE.Skeleton([bone]));
    mockGroup.add(mesh);

    vi.mocked(skinnedMannequin.loadMannequin).mockResolvedValue(mockGroup);

    // Also spy on the logic functions to ensure they are called
    const setupSpy = vi.spyOn(skinnedMannequin, "setupMannequinMaterials");
    const poseSpy = vi.spyOn(skinnedMannequin, "applyPoseToSkeleton");
    const colorSpy = vi.spyOn(skinnedMannequin, "applyMuscleHeatColors");

    render(<PoseViewer3D />);

    // Should show loading
    expect(screen.getByText(/3Dモデルを読み込み中.../)).toBeDefined();

    // Eventually loads
    await waitFor(() => {
      expect(setupSpy).toHaveBeenCalledWith(mockGroup);
      expect(poseSpy).toHaveBeenCalled();
      expect(colorSpy).toHaveBeenCalled();
    });

    // 接触影のためスキンメッシュに castShadow が付与される（#69）。
    // frustumCulled はスキン変形時のシャドウ欠け防止のため無効化される。
    expect(mesh.castShadow).toBe(true);
    expect(mesh.frustumCulled).toBe(false);
  });

  it("ケース 5: checkGolden が penetrations に narrowRefined フラグを反映する", async () => {
    const mockGroup = new THREE.Group();
    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3)
    );
    const mesh = new THREE.SkinnedMesh(geom, new THREE.MeshBasicMaterial());
    const bone = new THREE.Bone();
    bone.name = "mixamorig:Hips";
    mesh.bind(new THREE.Skeleton([bone]));
    mockGroup.add(mesh);

    vi.mocked(skinnedMannequin.loadMannequin).mockResolvedValue(mockGroup);

    render(<PoseViewer3D />);

    await waitFor(() => {
      expect((window as unknown as Record<string, unknown>).__poseDebug).toBeDefined();
    });

    const dbg = (
      window as unknown as {
        __poseDebug: {
          checkGolden: (g: unknown) => {
            penetrations: unknown;
            penetrationPass: unknown;
          };
        };
      }
    ).__poseDebug;
    const golden = { pose: "test_pose", rotations: {} };
    const report = dbg.checkGolden(golden);

    expect(report.penetrations).toBeDefined();
    expect(report.penetrationPass).toBeDefined();
  });
});
