import { create } from "zustand";
import type { NormalizedLandmark, Landmark } from "@mediapipe/tasks-vision";

interface ImageSize {
  width: number;
  height: number;
}

interface PoseState {
  landmarks: NormalizedLandmark[] | null;
  worldLandmarks: Landmark[] | null;
  imageSize: ImageSize | null;
  isError: boolean;
  errorMessage: string | null;
  isLoading: boolean;
  imageSrc: string | null;
  setPoseResult: (
    landmarks: NormalizedLandmark[],
    worldLandmarks: Landmark[],
    imageSize: ImageSize
  ) => void;
  setError: (message: string) => void;
  setLoading: (loading: boolean) => void;
  setImageSrc: (src: string | null) => void;
  reset: () => void;
}

export const usePoseStore = create<PoseState>((set) => ({
  landmarks: null,
  worldLandmarks: null,
  imageSize: null,
  isError: false,
  errorMessage: null,
  isLoading: false,
  imageSrc: null,
  setPoseResult: (landmarks, worldLandmarks, imageSize) =>
    set({
      landmarks,
      worldLandmarks,
      imageSize,
      isError: false,
      errorMessage: null,
      isLoading: false,
    }),
  setError: (message) =>
    set({
      landmarks: null,
      worldLandmarks: null,
      imageSize: null,
      isError: true,
      errorMessage: message,
      isLoading: false,
    }),
  setLoading: (loading) => set({ isLoading: loading }),
  setImageSrc: (src) => set({ imageSrc: src }),
  reset: () =>
    set({
      landmarks: null,
      worldLandmarks: null,
      imageSize: null,
      isError: false,
      errorMessage: null,
      isLoading: false,
      imageSrc: null,
    }),
}));
