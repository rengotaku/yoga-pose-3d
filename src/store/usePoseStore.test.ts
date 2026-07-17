import { describe, it, expect, beforeEach } from "vitest";
import { usePoseStore } from "./usePoseStore";

describe("usePoseStore", () => {
  beforeEach(() => {
    usePoseStore.getState().reset();
  });

  it("should have initial state", () => {
    const state = usePoseStore.getState();
    expect(state.landmarks).toBeNull();
    expect(state.worldLandmarks).toBeNull();
    expect(state.isError).toBe(false);
    expect(state.errorMessage).toBeNull();
    expect(state.isLoading).toBe(false);
    expect(state.imageSrc).toBeNull();
  });

  it("should set pose results", () => {
    const mockLandmarks = [{ x: 0.1, y: 0.2, z: 0.3, visibility: 0.9 }];
    const mockWorldLandmarks = [{ x: 1, y: 2, z: 3, visibility: 0.9 }];

    usePoseStore.getState().setPoseResult(mockLandmarks, mockWorldLandmarks);

    const state = usePoseStore.getState();
    expect(state.landmarks).toEqual(mockLandmarks);
    expect(state.worldLandmarks).toEqual(mockWorldLandmarks);
    expect(state.isError).toBe(false);
    expect(state.errorMessage).toBeNull();
  });

  it("should set error", () => {
    usePoseStore.getState().setError("エラーメッセージ");

    const state = usePoseStore.getState();
    expect(state.landmarks).toBeNull();
    expect(state.worldLandmarks).toBeNull();
    expect(state.isError).toBe(true);
    expect(state.errorMessage).toBe("エラーメッセージ");
  });

  it("should set loading and imageSrc", () => {
    usePoseStore.getState().setLoading(true);
    usePoseStore.getState().setImageSrc("data:image/png;base64,...");

    const state = usePoseStore.getState();
    expect(state.isLoading).toBe(true);
    expect(state.imageSrc).toBe("data:image/png;base64,...");
  });

  it("should reset state", () => {
    usePoseStore.getState().setPoseResult([], []);
    usePoseStore.getState().setImageSrc("test");
    usePoseStore.getState().reset();

    const state = usePoseStore.getState();
    expect(state.landmarks).toBeNull();
    expect(state.worldLandmarks).toBeNull();
    expect(state.isError).toBe(false);
    expect(state.errorMessage).toBeNull();
    expect(state.imageSrc).toBeNull();
  });
});
