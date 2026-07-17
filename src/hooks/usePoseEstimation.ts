import { useState, useCallback, useRef } from "react";
import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import { usePoseStore } from "../store/usePoseStore";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task";

export const usePoseEstimation = () => {
  const [isInitializing, setIsInitializing] = useState(false);
  const landmarkerRef = useRef<PoseLandmarker | null>(null);

  const { setPoseResult, setError, setLoading } = usePoseStore();

  const initLandmarker = useCallback(async () => {
    if (landmarkerRef.current || isInitializing) return;

    setIsInitializing(true);
    try {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm"
      );
      landmarkerRef.current = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MODEL_URL,
          delegate: "GPU",
        },
        runningMode: "IMAGE",
        numPoses: 1,
      });
    } catch (err) {
      console.error("Failed to initialize PoseLandmarker:", err);
      setError("モデルの初期化に失敗しました。");
    } finally {
      setIsInitializing(false);
    }
  }, [isInitializing, setError]);

  const estimatePose = useCallback(
    async (imageElement: HTMLImageElement) => {
      setLoading(true);

      if (!landmarkerRef.current) {
        await initLandmarker();
      }

      if (!landmarkerRef.current) {
        setError("モデルがロードされていません。");
        setLoading(false);
        return;
      }

      try {
        const result = landmarkerRef.current.detect(imageElement);

        if (result.landmarks.length > 0 && result.worldLandmarks.length > 0) {
          setPoseResult(result.landmarks[0], result.worldLandmarks[0]);
        } else {
          setError("人物が検出されませんでした。");
        }
      } catch (err) {
        console.error("Pose estimation error:", err);
        setError("ポーズ推定中にエラーが発生しました。");
      } finally {
        setLoading(false);
      }
    },
    [initLandmarker, setPoseResult, setError, setLoading]
  );

  return {
    estimatePose,
    initLandmarker,
    isInitializing,
  };
};
