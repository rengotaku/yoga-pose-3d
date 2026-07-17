import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PoseCanvas } from "./PoseCanvas";
import { usePoseStore } from "../../store/usePoseStore";

const mockEstimatePose = vi.fn();
vi.mock("../../hooks/usePoseEstimation", () => ({
  usePoseEstimation: () => ({
    estimatePose: mockEstimatePose,
  }),
}));

const mockDrawLandmarks = vi.fn();
const mockDrawConnectors = vi.fn();

vi.mock("@mediapipe/tasks-vision", () => {
  return {
    DrawingUtils: class {
      static lerp = vi.fn().mockReturnValue(2);
      drawLandmarks = mockDrawLandmarks;
      drawConnectors = mockDrawConnectors;
    },
    PoseLandmarker: {
      POSE_CONNECTIONS: [],
    },
  };
});

import { DrawingUtils } from "@mediapipe/tasks-vision";

describe("PoseCanvas", () => {
  beforeEach(() => {
    usePoseStore.getState().reset();
    vi.clearAllMocks();

    // Reset DrawingUtils.lerp since it's a static method used in PoseCanvas
    (DrawingUtils as unknown as { lerp: ReturnType<typeof vi.fn> }).lerp = vi
      .fn()
      .mockReturnValue(2);

    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
      clearRect: vi.fn(),
    }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  });

  it("renders nothing when imageSrc, isLoading and isError are all falsy", () => {
    const { container } = render(<PoseCanvas />);
    expect(container.firstChild).toBeNull();
  });

  it("renders loading state", () => {
    usePoseStore.getState().setImageSrc("test.jpg");
    usePoseStore.getState().setLoading(true);

    render(<PoseCanvas />);
    expect(screen.getByText("ポーズを推定中...")).toBeInTheDocument();
  });

  it("renders error state", () => {
    usePoseStore.getState().setImageSrc("test.jpg");
    usePoseStore.getState().setError("エラーが発生しました");

    render(<PoseCanvas />);
    expect(screen.getByText("エラーが発生しました")).toBeInTheDocument();
  });

  it("renders error state even when imageSrc is null", () => {
    usePoseStore.getState().setError("形式エラーが発生しました");

    render(<PoseCanvas />);
    expect(screen.getByText("形式エラーが発生しました")).toBeInTheDocument();
  });

  it("calls estimatePose on image load", () => {
    usePoseStore.getState().setImageSrc("test.jpg");

    render(<PoseCanvas />);
    const img = screen.getByAltText("Uploaded for pose estimation");
    fireEvent.load(img);

    expect(mockEstimatePose).toHaveBeenCalledWith(img);
  });

  it("draws landmarks on canvas when landmarks are available", () => {
    usePoseStore.getState().setImageSrc("test.jpg");
    const mockLandmarks = [{ x: 0, y: 0, z: 0, visibility: 1 }];
    usePoseStore.getState().setPoseResult(mockLandmarks, []);

    render(<PoseCanvas />);

    // Canvas should be rendered
    const canvas = document.querySelector("canvas");
    expect(canvas).toBeInTheDocument();

    // Image load
    const img = screen.getByAltText("Uploaded for pose estimation") as HTMLImageElement;

    // Mock image natural dimensions to trigger the branch in useEffect
    Object.defineProperty(img, "naturalWidth", { value: 100 });
    Object.defineProperty(img, "naturalHeight", { value: 100 });

    // We need to re-render to trigger useEffect with the new dimensions/DOM
    render(<PoseCanvas />);

    expect(mockDrawLandmarks).toHaveBeenCalledWith(mockLandmarks, expect.any(Object));
    expect(mockDrawConnectors).toHaveBeenCalled();

    // Test the radius callback
    const options = mockDrawLandmarks.mock.calls[0][1];
    const radius = options.radius({ from: { z: 0 } });
    expect(
      (DrawingUtils as unknown as { lerp: ReturnType<typeof vi.fn> }).lerp
    ).toHaveBeenCalled();
    expect(radius).toBe(2);
  });
});
