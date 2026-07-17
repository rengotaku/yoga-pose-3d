import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePoseEstimation } from "./usePoseEstimation";
import { usePoseStore } from "../store/usePoseStore";

// Mock MediaPipe
vi.mock("@mediapipe/tasks-vision", () => {
  return {
    FilesetResolver: {
      forVisionTasks: vi.fn().mockResolvedValue("vision_mock"),
    },
    PoseLandmarker: {
      createFromOptions: vi.fn().mockResolvedValue({
        detect: vi.fn(),
        close: vi.fn(),
      }),
    },
  };
});

import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

describe("usePoseEstimation", () => {
  beforeEach(() => {
    usePoseStore.getState().reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should initialize PoseLandmarker", async () => {
    const { result } = renderHook(() => usePoseEstimation());

    await act(async () => {
      await result.current.initLandmarker();
    });

    expect(FilesetResolver.forVisionTasks).toHaveBeenCalled();
    expect(PoseLandmarker.createFromOptions).toHaveBeenCalled();
  });

  it("should estimate pose successfully when landmarks are found", async () => {
    const mockDetect = vi.fn().mockReturnValue({
      landmarks: [[{ x: 0, y: 0, z: 0, visibility: 1 }]],
      worldLandmarks: [[{ x: 1, y: 1, z: 1, visibility: 1 }]],
    });

    (
      PoseLandmarker.createFromOptions as unknown as import("vitest").Mock
    ).mockResolvedValueOnce({
      detect: mockDetect,
      close: vi.fn(),
    });

    const { result } = renderHook(() => usePoseEstimation());

    // Initialize first
    await act(async () => {
      await result.current.initLandmarker();
    });

    const mockImage = new Image();

    await act(async () => {
      await result.current.estimatePose(mockImage);
    });

    expect(mockDetect).toHaveBeenCalledWith(mockImage);

    const state = usePoseStore.getState();
    expect(state.landmarks).toHaveLength(1);
    expect(state.worldLandmarks).toHaveLength(1);
    expect(state.isError).toBe(false);
  });

  it("should set error when no person is detected", async () => {
    const mockDetect = vi.fn().mockReturnValue({
      landmarks: [],
      worldLandmarks: [],
    });

    (
      PoseLandmarker.createFromOptions as unknown as import("vitest").Mock
    ).mockResolvedValueOnce({
      detect: mockDetect,
      close: vi.fn(),
    });

    const { result } = renderHook(() => usePoseEstimation());

    await act(async () => {
      await result.current.initLandmarker();
    });

    const mockImage = new Image();

    await act(async () => {
      await result.current.estimatePose(mockImage);
    });

    const state = usePoseStore.getState();
    expect(state.isError).toBe(true);
    expect(state.errorMessage).toBe("人物が検出されませんでした。");
  });

  it("should close landmarker on unmount", async () => {
    const mockClose = vi.fn();
    (
      PoseLandmarker.createFromOptions as unknown as import("vitest").Mock
    ).mockResolvedValueOnce({
      detect: vi.fn(),
      close: mockClose,
    });

    const { result, unmount } = renderHook(() => usePoseEstimation());

    await act(async () => {
      await result.current.initLandmarker();
    });

    unmount();
    expect(mockClose).toHaveBeenCalled();
  });

  it("should discard older estimation result when called rapidly", async () => {
    // Mock slow initialization
    const mockDetect = vi.fn().mockReturnValue({
      landmarks: [[{ x: 2, y: 2, z: 2, visibility: 1 }]],
      worldLandmarks: [[{ x: 3, y: 3, z: 3, visibility: 1 }]],
    });

    (
      PoseLandmarker.createFromOptions as unknown as import("vitest").Mock
    ).mockImplementationOnce(() => {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            detect: mockDetect,
            close: vi.fn(),
          });
        }, 100);
      });
    });

    const { result } = renderHook(() => usePoseEstimation());

    const mockImage1 = new Image();
    const mockImage2 = new Image();

    let p1, p2;
    await act(async () => {
      p1 = result.current.estimatePose(mockImage1);
      p2 = result.current.estimatePose(mockImage2);
      await Promise.all([p1, p2]);
    });

    const state = usePoseStore.getState();
    // mockDetect should only be called once because the first estimatePose aborted early
    expect(mockDetect).toHaveBeenCalledTimes(1);
    expect(mockDetect).toHaveBeenCalledWith(mockImage2);
    expect(state.landmarks).toEqual([{ x: 2, y: 2, z: 2, visibility: 1 }]);
  });
});
