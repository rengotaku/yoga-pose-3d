import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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
import { GOLDEN_POSES } from "./goldenPoses";
import * as skinnedMannequin from "../components/PoseViewer3D/skinnedMannequin";

vi.mock("../components/PoseViewer3D/skinnedMannequin", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../components/PoseViewer3D/skinnedMannequin")>();
  return {
    ...mod,
    loadMannequin: vi.fn(),
  };
});

describe("GoldenViewerPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(skinnedMannequin.loadMannequin).mockResolvedValue(new THREE.Group());
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
});
