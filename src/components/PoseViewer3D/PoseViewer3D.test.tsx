import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import * as THREE from "three";
import { generateMannequin } from "./mannequin";
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

// 立位（腕を横、脚をまっすぐ）に近い最小限のランドマーク集合。
// worldLandmarks は腰中心が原点付近、単位はおよそメートル。
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

// 木のポーズ相当: 右脚は buildStanding のまま接地・伸展、左脚を持ち上げて
// （右脚の内側に沿わせるイメージで）膝から真っ直ぐ前上方へ伸ばした片脚立ち。
// 左足首・左膝・左足趾は腰から見て一直線（膝は曲げていない）だが、
// 接地からの浮き上がりと腰中心からの水平距離により支持脚判定は L=0 になる。
const buildTreePose = (): RawLandmark[] => {
  const lm = buildStanding();
  const hipL = lm[LM.LEFT_HIP]; // { x: 0.1, y: 0, z: 0 }
  const dir = { x: 0.248, y: 0.62, z: -0.744 }; // 単位ベクトル（前方かつ上方）
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
    bent[LM.LEFT_WRIST] = { x: 0.18, y: -0.45, z: -0.1 }; // 左肘を曲げる

    expect(computeActivations(bent)["biceps:L"]).toBeGreaterThan(
      computeActivations(straight)["biceps:L"]
    );
  });

  it("bent knee raises quadriceps activation", () => {
    const straight = buildStanding();
    const squat = buildStanding();
    squat[LM.LEFT_ANKLE] = { x: 0.1, y: 0.7, z: -0.35 }; // 左膝を曲げる

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

describe("generateMannequin", () => {
  it("creates a Three.js Group named 'mannequin' and adds it to the scene", () => {
    const scene = new THREE.Scene();
    const mannequin = generateMannequin(buildStanding(), scene);

    expect(mannequin).toBeInstanceOf(THREE.Group);
    expect(mannequin.name).toBe("mannequin");
    expect(scene.children).toContain(mannequin);
  });

  it("builds a fleshed body: a torso mesh plus 10 limb capsules", () => {
    const scene = new THREE.Scene();
    const mannequin = generateMannequin(buildStanding(), scene);

    expect(mannequin.getObjectByName("torso")).toBeDefined();

    const capsules = mannequin.children.filter(
      (c) => (c as THREE.Mesh).geometry instanceof THREE.CapsuleGeometry
    );
    // 上腕2 + 前腕2 + 大腿(四頭筋+ハム)4 + 下腿2 = 10
    expect(capsules.length).toBe(10);
  });

  it("splits each thigh into a quadriceps-only and a hamstrings-only capsule", () => {
    const scene = new THREE.Scene();
    const mannequin = generateMannequin(buildStanding(), scene);

    const capsules = mannequin.children.filter(
      (c) => (c as THREE.Mesh).geometry instanceof THREE.CapsuleGeometry
    ) as THREE.Mesh[];

    const quadOnly = capsules.filter(
      (c) => (c.userData.muscles as string[]).join(",") === "quadriceps"
    );
    const hamOnly = capsules.filter(
      (c) => (c.userData.muscles as string[]).join(",") === "hamstrings"
    );
    // 左右それぞれ1つずつ
    expect(quadOnly.length).toBe(2);
    expect(hamOnly.length).toBe(2);

    // 大腿カプセルはもう四頭筋/ハムの両方を1つのメッシュで持たない
    const mixedThigh = capsules.filter((c) => {
      const m = c.userData.muscles as string[];
      return m.includes("quadriceps") && m.includes("hamstrings");
    });
    expect(mixedThigh.length).toBe(0);

    // 前後に分離しているので、同じ左脚内の四頭筋/ハムの位置は異なる
    const leftQuad = quadOnly.find((c) => c.position.x > 0);
    const leftHam = hamOnly.find((c) => c.position.x > 0);
    expect(leftQuad).toBeDefined();
    expect(leftHam).toBeDefined();
    expect(leftQuad!.position.distanceTo(leftHam!.position)).toBeGreaterThan(0);
  });

  it("does not throw on incomplete landmarks", () => {
    const scene = new THREE.Scene();
    expect(() => generateMannequin([{ x: 0, y: 0, z: 0 }], scene)).not.toThrow();
  });

  it("assigns muscle IDs to mesh userData", () => {
    const scene = new THREE.Scene();
    const mannequin = generateMannequin(buildStanding(), scene);

    const torso = mannequin.getObjectByName("torso");
    expect(torso?.userData.muscles).toContain("core");

    let foundBiceps = false;
    let foundHamstrings = false;
    mannequin.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const m = child.userData.muscles || [];
        if (m.includes("biceps")) foundBiceps = true;
        if (m.includes("hamstrings")) foundHamstrings = true;
      }
    });
    expect(foundBiceps).toBe(true);
    expect(foundHamstrings).toBe(true);
  });
});

describe("calculateCameraFit", () => {
  it("calculates correct camera position and target for a given bounding box", () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    // BoundingSphere radius is sqrt(3) ~= 1.732
    const result = calculateCameraFit(box, 45, 1.3);

    expect(result.target.x).toBeCloseTo(0);
    expect(result.target.y).toBeCloseTo(0);
    expect(result.target.z).toBeCloseTo(0);

    const fovRad = (45 * Math.PI) / 180;
    const expectedDistance = (Math.sqrt(3) * 1.3) / Math.sin(fovRad / 2);
    expect(result.position.z).toBeCloseTo(expectedDistance);
    expect(result.position.x).toBeCloseTo(0);
    expect(result.position.y).toBeCloseTo(0);
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
