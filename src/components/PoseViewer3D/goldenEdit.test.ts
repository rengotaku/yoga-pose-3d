import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { applyGoldenRotations, type GoldenPose } from "./golden";
import {
  createEditHistory,
  exportGoldenRotations,
  pushHistory,
  redo,
  undo,
  MAX_HISTORY_STEPS,
  type EditHistory,
} from "./goldenEdit";

/**
 * UE 系命名の 4 ボーン階層（実 glb と同じ名前解決経路を通す）。
 * バインドポーズ自体を非恒等にして（実 glb のレストポーズ同様）、
 * offset = bind⁻¹ × current の逆変換が本当にバインド差分を除去できるか検証する。
 */
const buildRig = () => {
  const root = new THREE.Group();
  const pelvis = new THREE.Bone();
  pelvis.name = "pelvis";
  const spine01 = new THREE.Bone();
  spine01.name = "spine_01";
  const spine02 = new THREE.Bone();
  spine02.name = "spine_02";
  const upperarmL = new THREE.Bone();
  upperarmL.name = "upperarm_l";

  pelvis.add(spine01);
  spine01.add(spine02);
  spine02.add(upperarmL);
  root.add(pelvis);

  pelvis.quaternion.setFromEuler(new THREE.Euler(0.05, -0.1, 0.02));
  spine01.quaternion.setFromEuler(new THREE.Euler(-0.02, 0.03, 0.01));
  spine02.quaternion.setFromEuler(new THREE.Euler(0.01, -0.02, 0.04));
  upperarmL.quaternion.setFromEuler(new THREE.Euler(0, 0, -1.2));

  const initial = new Map<string, THREE.Quaternion>();
  for (const b of [pelvis, spine01, spine02, upperarmL]) {
    initial.set(b.name, b.quaternion.clone());
  }
  return { root, pelvis, spine01, spine02, upperarmL, initial };
};

const DEG_TOLERANCE = THREE.MathUtils.degToRad(0.6); // 丸め 0.5° + 浮動小数の余裕

describe("exportGoldenRotations", () => {
  it("round-trips ordinary angles within 0.5 degrees", () => {
    const { root, pelvis, spine01, upperarmL, initial } = buildRig();
    const golden: GoldenPose = {
      pose: "t",
      rotations: { Hips: [10, 20, 30], Spine: [5, -15, 0] },
    };
    applyGoldenRotations(root, initial, golden);

    const exported = exportGoldenRotations(root, initial, ["Hips", "Spine"]);
    expect(exported.Hips[0]).toBeCloseTo(10, 0);
    expect(exported.Hips[1]).toBeCloseTo(20, 0);
    expect(exported.Hips[2]).toBeCloseTo(30, 0);
    expect(exported.Spine[0]).toBeCloseTo(5, 0);
    expect(exported.Spine[1]).toBeCloseTo(-15, 0);
    expect(exported.Spine[2]).toBeCloseTo(0, 0);

    // 恒等のまま触っていないボーンは baseBones 指定なしでは出力されない
    expect(exported.Spine1).toBeUndefined();
    expect(exported.LeftArm).toBeUndefined();

    // エクスポート結果を再適用すると同じ最終姿勢に戻る（数値ではなく実際の回転で判定）
    const beforeHips = pelvis.quaternion.clone();
    const beforeSpine = spine01.quaternion.clone();
    applyGoldenRotations(root, initial, { pose: "t2", rotations: exported });
    expect(pelvis.quaternion.angleTo(beforeHips)).toBeLessThan(DEG_TOLERANCE);
    expect(spine01.quaternion.angleTo(beforeSpine)).toBeLessThan(DEG_TOLERANCE);
    // 元々操作していない upperarm_l はバインドポーズのまま変化しない
    expect(upperarmL.quaternion.angleTo(initial.get("upperarm_l")!)).toBeLessThan(1e-6);
  });

  it("round-trips a near-gimbal rotation ([90, 175, 0]) via the resulting orientation", () => {
    const { root, upperarmL, initial } = buildRig();
    const golden: GoldenPose = {
      pose: "gimbal",
      rotations: { LeftArm: [90, 175, 0] },
    };
    applyGoldenRotations(root, initial, golden);
    const before = upperarmL.quaternion.clone();

    const exported = exportGoldenRotations(root, initial, ["LeftArm"]);
    expect(exported.LeftArm).toBeDefined();
    // ジンバル近傍では Euler 分解が別の等価な三つ組を返し得るため、
    // 生の数値一致ではなく再適用後の実回転で一致を確認する
    for (const v of exported.LeftArm) {
      expect(v).toBeGreaterThanOrEqual(-180);
      expect(v).toBeLessThanOrEqual(180);
    }

    applyGoldenRotations(root, initial, { pose: "gimbal2", rotations: exported });
    expect(upperarmL.quaternion.angleTo(before)).toBeLessThan(DEG_TOLERANCE);
  });

  it("omits identity bones unless listed in baseBones", () => {
    const { root, initial } = buildRig();
    const golden: GoldenPose = {
      pose: "t",
      rotations: { Spine: [12, 0, 0] },
    };
    applyGoldenRotations(root, initial, golden);

    const withoutBase = exportGoldenRotations(root, initial, []);
    expect(withoutBase.Spine).toBeDefined();
    expect(withoutBase.Hips).toBeUndefined();
    expect(withoutBase.LeftArm).toBeUndefined();

    const withBase = exportGoldenRotations(root, initial, ["Hips", "Spine"]);
    expect(withBase.Hips).toEqual([0, 0, 0]);
    expect(withBase.Spine[0]).toBeCloseTo(12, 0);
    // baseBones に無い恒等ボーンは引き続き省略される
    expect(withBase.LeftArm).toBeUndefined();
  });
});

describe("edit history (createEditHistory / pushHistory / undo / redo)", () => {
  it("supports push then undo/redo across multiple steps", () => {
    let history: EditHistory<number> = createEditHistory();
    let current = 0;

    history = pushHistory(history, current);
    current = 1;
    history = pushHistory(history, current);
    current = 2;

    let result = undo(history, current);
    expect(result).not.toBeNull();
    history = result!.history;
    current = result!.current;
    expect(current).toBe(1);

    result = undo(history, current);
    history = result!.history;
    current = result!.current;
    expect(current).toBe(0);

    expect(undo(history, current)).toBeNull();

    result = redo(history, current);
    history = result!.history;
    current = result!.current;
    expect(current).toBe(1);

    result = redo(history, current);
    history = result!.history;
    current = result!.current;
    expect(current).toBe(2);

    expect(redo(history, current)).toBeNull();
  });

  it("discards the redo branch when a new edit is pushed", () => {
    let history: EditHistory<number> = createEditHistory();
    history = pushHistory(history, 0);
    let current = 1;
    history = pushHistory(history, current);
    current = 2;

    const undone = undo(history, current)!;
    history = undone.history;
    current = undone.current;
    expect(history.future.length).toBe(1);

    history = pushHistory(history, current);
    expect(history.future.length).toBe(0);
  });

  it("caps the stack at MAX_HISTORY_STEPS entries, dropping the oldest", () => {
    let history: EditHistory<number> = createEditHistory();
    for (let i = 0; i < MAX_HISTORY_STEPS + 5; i++) {
      history = pushHistory(history, i);
    }
    expect(history.past.length).toBe(MAX_HISTORY_STEPS);
    expect(history.past[0]).toBe(5);
    expect(history.past[history.past.length - 1]).toBe(MAX_HISTORY_STEPS + 4);
  });

  it("never mutates the input history (immutability)", () => {
    const h0: EditHistory<number> = createEditHistory();
    const h1 = pushHistory(h0, 5);
    expect(h0.past).toEqual([]);
    expect(h1.past).toEqual([5]);
    expect(h0).not.toBe(h1);

    const undone = undo(h1, 6)!;
    expect(h1.past).toEqual([5]);
    expect(h1.future).toEqual([]);
    expect(undone.history.past).toEqual([]);
    expect(undone.history.future).toEqual([6]);
  });
});
