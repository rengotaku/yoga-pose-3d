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
});
