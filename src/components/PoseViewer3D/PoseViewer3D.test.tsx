import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { generateMannequin } from "./mannequin";
import {
  angleAt,
  flexion,
  computeActivations,
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

  it("builds a fleshed body: a torso mesh plus 8 limb capsules", () => {
    const scene = new THREE.Scene();
    const mannequin = generateMannequin(buildStanding(), scene);

    expect(mannequin.getObjectByName("torso")).toBeDefined();

    const capsules = mannequin.children.filter(
      (c) => (c as THREE.Mesh).geometry instanceof THREE.CapsuleGeometry
    );
    // 上腕2 + 前腕2 + 大腿2 + 下腿2 = 8
    expect(capsules.length).toBe(8);
  });

  it("does not throw on incomplete landmarks", () => {
    const scene = new THREE.Scene();
    expect(() => generateMannequin([{ x: 0, y: 0, z: 0 }], scene)).not.toThrow();
  });
});
