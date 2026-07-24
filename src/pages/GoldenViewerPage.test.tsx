import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
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
import { GoldenViewerPage } from "./GoldenViewerPage";
type MockTransformControls = THREE.EventDispatcher & {
  mode: string;
  space: string;
  enabled: boolean;
  object: THREE.Object3D | null;
  getHelper(): THREE.Object3D;
  attach(obj: THREE.Object3D): void;
  detach(): void;
  dispose(): void;
  dispatchEvent(event: { type: string; [key: string]: unknown }): void;
};
let lastTransformControls: MockTransformControls | null = null;

vi.mock("three/addons/controls/TransformControls.js", () => {
  return {
    TransformControls: class extends THREE.EventDispatcher {
      mode = "rotate";
      space = "local";
      enabled = true;
      object: THREE.Object3D | null = null;
      constructor() {
        super();
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        lastTransformControls = this as unknown as MockTransformControls;
      }
      getHelper() {
        return new THREE.Object3D();
      }
      attach(obj: THREE.Object3D) {
        this.object = obj;
      }
      detach() {
        this.object = null;
      }
      dispose() {}
    },
  };
});

function createMockMannequinGroup(): THREE.Group {
  const root = new THREE.Group();
  const hips = new THREE.Bone();
  hips.name = "mixamorig:Hips";
  hips.userData.stdName = "Hips";
  root.add(hips);

  const spine = new THREE.Bone();
  spine.name = "mixamorig:Spine";
  spine.userData.stdName = "Spine";
  hips.add(spine);

  const spine1 = new THREE.Bone();
  spine1.name = "mixamorig:Spine1";
  spine1.userData.stdName = "Spine1";
  spine.add(spine1);

  const neck = new THREE.Bone();
  neck.name = "mixamorig:Neck";
  neck.userData.stdName = "Neck";
  spine1.add(neck);

  const head = new THREE.Bone();
  head.name = "mixamorig:Head";
  head.userData.stdName = "Head";
  neck.add(head);

  const leftArm = new THREE.Bone();
  leftArm.name = "mixamorig:LeftArm";
  leftArm.userData.stdName = "LeftArm";
  spine1.add(leftArm);

  const leftForeArm = new THREE.Bone();
  leftForeArm.name = "mixamorig:LeftForeArm";
  leftForeArm.userData.stdName = "LeftForeArm";
  leftArm.add(leftForeArm);

  const leftHand = new THREE.Bone();
  leftHand.name = "mixamorig:LeftHand";
  leftHand.userData.stdName = "LeftHand";
  leftForeArm.add(leftHand);

  const rightArm = new THREE.Bone();
  rightArm.name = "mixamorig:RightArm";
  rightArm.userData.stdName = "RightArm";
  spine1.add(rightArm);

  const rightForeArm = new THREE.Bone();
  rightForeArm.name = "mixamorig:RightForeArm";
  rightForeArm.userData.stdName = "RightForeArm";
  rightArm.add(rightForeArm);

  const rightHand = new THREE.Bone();
  rightHand.name = "mixamorig:RightHand";
  rightHand.userData.stdName = "RightHand";
  rightForeArm.add(rightHand);

  const bones = [
    hips,
    spine,
    spine1,
    neck,
    head,
    leftArm,
    leftForeArm,
    leftHand,
    rightArm,
    rightForeArm,
    rightHand,
  ];
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.SkinnedMesh(geometry, material);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton);
  root.add(mesh);

  return root;
}

import { GOLDEN_POSES } from "./goldenPoses";
import * as skinnedMannequin from "../components/PoseViewer3D/skinnedMannequin";
import * as poseValidity from "../components/PoseViewer3D/poseValidity";

vi.mock("../components/PoseViewer3D/skinnedMannequin", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../components/PoseViewer3D/skinnedMannequin")>();
  return {
    ...mod,
    loadMannequin: vi.fn(),
  };
});

// #128: detectSelfPenetrations を warn-only の合成結果に差し替えて、gateReport の
// pass 表示（めり込み(fail)）が warn では落ちないことを検証する
vi.mock("../components/PoseViewer3D/poseValidity", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../components/PoseViewer3D/poseValidity")>();
  return {
    ...mod,
    detectSelfPenetrations: vi.fn(mod.detectSelfPenetrations),
  };
});

describe("GoldenViewerPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(skinnedMannequin.loadMannequin).mockImplementation(async () =>
      createMockMannequinGroup()
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("collects golden poses from e2e/golden and excludes samples", () => {
    expect(GOLDEN_POSES.length).toBeGreaterThanOrEqual(3);
    expect(GOLDEN_POSES.map((g) => g.pose)).toEqual(
      expect.arrayContaining(["kneel-sidebend", "cross-seat", "tabletop"])
    );
    expect(GOLDEN_POSES.some((g) => g.pose.startsWith("_"))).toBe(false);
  });

  it("renders a button per pose and switches selection", async () => {
    render(<GoldenViewerPage />);
    for (const g of GOLDEN_POSES) {
      expect(screen.getByRole("button", { name: g.pose })).toBeDefined();
    }
    const tabletop = GOLDEN_POSES.find((g) => g.pose === "tabletop");
    fireEvent.click(screen.getByRole("button", { name: "tabletop" }));
    await waitFor(() => {
      if (tabletop?.description) {
        expect(screen.getByText(tabletop.description)).toBeDefined();
      }
    });
  });

  it("disables the stability toggle until the initial stability calculation completes (#119)", async () => {
    render(<GoldenViewerPage />);

    // GLB ロード直後（stabilityView 未生成）は同期的にトグルが disabled。
    // ここで ON にできてしまうと (0,0,0) に「安定」扱いの緑マーカーが
    // 誤表示される false PASS になるため、disabled で操作自体を防ぐ
    const toggle = screen.getByRole("checkbox", {
      name: "重心/支持面を表示",
    }) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.checked).toBe(false);
    expect(
      (
        window as unknown as { __stabilityDebug?: { isMounted: () => boolean } }
      ).__stabilityDebug?.isMounted()
    ).toBe(false);

    // ロード完了（stabilityView 計算済み）でトグルが有効になる
    await waitFor(() => {
      expect(toggle.disabled).toBe(false);
    });
  });

  it("shows the COM/support-polygon marker when toggled on, and removes it when toggled off (#119)", async () => {
    render(<GoldenViewerPage />);

    const toggle = screen.getByRole("checkbox", {
      name: "重心/支持面を表示",
    }) as HTMLInputElement;

    // ロード完了（重心/支持面トグルが押せる状態）を待つ。disabled のまま
    // クリックすると onChange が発火せず後続の待機が timeout するため、
    // 有効化されたことを確認してから操作する
    await waitFor(() => {
      expect(toggle.disabled).toBe(false);
    });

    // トグル ON 前: オーバーレイは無く、3D マーカーも scene に mount されていない
    expect(screen.queryByTestId("stability-overlay")).toBeNull();
    expect(
      (
        window as unknown as { __stabilityDebug?: { isMounted: () => boolean } }
      ).__stabilityDebug?.isMounted()
    ).toBe(false);

    fireEvent.click(toggle);

    // トグル ON: COM マーカー・支持多角形ラインが scene に mount され、
    // 境界距離のオーバーレイが表示される
    await waitFor(() => {
      expect(screen.getByTestId("stability-overlay")).toBeDefined();
      expect(
        (
          window as unknown as { __stabilityDebug?: { isMounted: () => boolean } }
        ).__stabilityDebug?.isMounted()
      ).toBe(true);
    });

    fireEvent.click(toggle);

    // トグル OFF: マーカー・ラインが scene から remove され、オーバーレイも消える
    await waitFor(() => {
      expect(screen.queryByTestId("stability-overlay")).toBeNull();
      expect(
        (
          window as unknown as { __stabilityDebug?: { isMounted: () => boolean } }
        ).__stabilityDebug?.isMounted()
      ).toBe(false);
    });
  });

  // 追加テスト（#128）: warn severity のみの penetration では pass 表示（緑）が
  // 落ちないことを、編集モードのゲート表示で確認する
  it("keeps the penetration pass indicator green when only warn-severity penetrations exist (#128)", async () => {
    vi.mocked(poseValidity.detectSelfPenetrations).mockReturnValue([
      { a: "thigh:L", b: "thigh:R", depthM: 0.05, severity: "warn" },
    ]);

    render(<GoldenViewerPage />);

    const editButton = await screen.findByRole("button", { name: "編集: OFF" });
    fireEvent.click(editButton);

    await waitFor(
      () => {
        const failLine = screen.getByText(/めり込み\(fail\)/);
        expect(failLine.textContent).toContain("0 件");
        expect(failLine.className).toContain("text-emerald-300");
      },
      { timeout: 2000 }
    );

    const warnLine = screen.getByText(/めり込み\(warn\)/);
    expect(warnLine.textContent).toContain("1 件");
    expect(warnLine.className).toContain("text-amber-300");
  });

  it("ケース 6: gizmo 統合 (reject パスで赤フラッシュ + blockedPairs UI 表示)", async () => {
    const clampModule = await import("../components/PoseViewer3D/clampInput");
    vi.spyOn(clampModule, "tryApplyWithClamp").mockReturnValue({
      accepted: false,
      blockedPairs: [{ a: "chest", b: "foreArm:R" }],
    });

    render(<GoldenViewerPage />);

    const editButton = await screen.findByRole("button", { name: "編集: OFF" });
    fireEvent.click(editButton);

    await waitFor(() => {
      expect(lastTransformControls).not.toBeNull();
    });

    const mannequinGroup = await skinnedMannequin.loadMannequin("");
    const rightArm = mannequinGroup.getObjectByName("mixamorig:RightArm") as THREE.Bone;
    if (lastTransformControls) {
      lastTransformControls.object = rightArm;
    }

    // handleObjectChange を起動
    act(() => {
      lastTransformControls?.dispatchEvent({ type: "objectChange" });
    });

    await waitFor(() => {
      expect(screen.getByText(/clamp: chest × foreArm:R/i)).toBeDefined();
      expect(screen.getByTestId("red-flash")).toBeDefined();
    });
  });

  it("ケース 6: gizmo 統合 (accept パスで blockedPairs がクリアされる)", async () => {
    const clampModule = await import("../components/PoseViewer3D/clampInput");
    const spy = vi.spyOn(clampModule, "tryApplyWithClamp");

    spy.mockReturnValueOnce({
      accepted: false,
      blockedPairs: [{ a: "chest", b: "foreArm:R" }],
    });

    render(<GoldenViewerPage />);

    const editButton = await screen.findByRole("button", { name: "編集: OFF" });
    fireEvent.click(editButton);

    await waitFor(() => {
      expect(lastTransformControls).not.toBeNull();
    });

    const mannequinGroup = await skinnedMannequin.loadMannequin("");
    const rightArm = mannequinGroup.getObjectByName("mixamorig:RightArm") as THREE.Bone;
    if (lastTransformControls) {
      lastTransformControls.object = rightArm;
    }

    // 1 回目: reject で UI 表示
    act(() => {
      lastTransformControls?.dispatchEvent({ type: "objectChange" });
    });
    await waitFor(() => {
      expect(screen.getByText(/clamp: chest × foreArm:R/i)).toBeDefined();
    });

    // 2 回目: accept に復帰
    spy.mockReturnValueOnce({
      accepted: true,
      blockedPairs: [],
    });
    act(() => {
      lastTransformControls?.dispatchEvent({ type: "objectChange" });
    });

    // blockedPairs UI が消えること
    await waitFor(() => {
      expect(screen.queryByTestId("blocked-pairs")).toBeNull();
    });
  });
});
