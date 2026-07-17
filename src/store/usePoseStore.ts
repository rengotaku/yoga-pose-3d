import { create } from "zustand";
import type { NormalizedLandmark, Landmark } from "@mediapipe/tasks-vision";

interface PoseState {
  landmarks: NormalizedLandmark[] | null;
  worldLandmarks: Landmark[] | null;
  isError: boolean;
  errorMessage: string | null;
  isLoading: boolean;
  imageSrc: string | null;
  setPoseResult: (landmarks: NormalizedLandmark[], worldLandmarks: Landmark[]) => void;
  setError: (message: string) => void;
  setLoading: (loading: boolean) => void;
  setImageSrc: (src: string | null) => void;
  reset: () => void;
}

export const usePoseStore = create<PoseState>((set) => ({
  landmarks: null,
  worldLandmarks: null,
  isError: false,
  errorMessage: null,
  isLoading: false,
  imageSrc: null,
  setPoseResult: (landmarks, worldLandmarks) =>
    set({
      landmarks,
      worldLandmarks,
      isError: false,
      errorMessage: null,
      isLoading: false,
    }),
  setError: (message) =>
    set({
      landmarks: null,
      worldLandmarks: null,
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
      isError: false,
      errorMessage: null,
      isLoading: false,
      imageSrc: null,
    }),
}));
