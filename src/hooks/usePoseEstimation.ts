import { useState, useCallback, useRef, useEffect } from "react";
import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import { usePoseStore } from "../store/usePoseStore";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task";

export const usePoseEstimation = () => {
  const [isInitializing, setIsInitializing] = useState(false);
  const landmarkerRef = useRef<PoseLandmarker | null>(null);
  const initPromiseRef = useRef<Promise<void> | null>(null);
  const requestTokenRef = useRef<number>(0);

  const setPoseResult = usePoseStore((s) => s.setPoseResult);
  const setError = usePoseStore((s) => s.setError);
  const setLoading = usePoseStore((s) => s.setLoading);

  const initLandmarker = useCallback(async () => {
    if (landmarkerRef.current) return;
    if (initPromiseRef.current) return initPromiseRef.current;

    setIsInitializing(true);
    initPromiseRef.current = (async () => {
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
        initPromiseRef.current = null;
      }
    })();

    return initPromiseRef.current;
  }, [setError]);

  const estimatePose = useCallback(
    async (imageElement: HTMLImageElement) => {
      requestTokenRef.current += 1;
      const currentToken = requestTokenRef.current;

      setLoading(true);

      if (!landmarkerRef.current) {
        await initLandmarker();
      }

      if (currentToken !== requestTokenRef.current) return;

      if (!landmarkerRef.current) {
        setError("モデルがロードされていません。");
        setLoading(false);
        return;
      }

      try {
        const result = landmarkerRef.current.detect(imageElement);

        if (currentToken !== requestTokenRef.current) return;

        if (result.landmarks.length > 0 && result.worldLandmarks.length > 0) {
          setPoseResult(result.landmarks[0], result.worldLandmarks[0], {
            width: imageElement.naturalWidth,
            height: imageElement.naturalHeight,
          });
        } else {
          setError("人物が検出されませんでした。");
        }
      } catch (err) {
        if (currentToken !== requestTokenRef.current) return;
        console.error("Pose estimation error:", err);
        setError("ポーズ推定中にエラーが発生しました。");
      } finally {
        if (currentToken === requestTokenRef.current) {
          setLoading(false);
        }
      }
    },
    [initLandmarker, setPoseResult, setError, setLoading]
  );

  useEffect(() => {
    return () => {
      if (landmarkerRef.current) {
        landmarkerRef.current.close();
      }
    };
  }, []);

  return {
    estimatePose,
    initLandmarker,
    isInitializing,
  };
};
