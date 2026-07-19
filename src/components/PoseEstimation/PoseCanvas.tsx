import React, { useEffect, useRef } from "react";
import { DrawingUtils, PoseLandmarker } from "@mediapipe/tasks-vision";
import { usePoseStore } from "../../store/usePoseStore";
import { usePoseEstimation } from "../../hooks/usePoseEstimation";
import { isVisible, VISIBILITY_GATE } from "../PoseViewer3D/muscles";

export const PoseCanvas: React.FC = () => {
  const imageSrc = usePoseStore((s) => s.imageSrc);
  const landmarks = usePoseStore((s) => s.landmarks);
  const isLoading = usePoseStore((s) => s.isLoading);
  const isError = usePoseStore((s) => s.isError);
  const errorMessage = usePoseStore((s) => s.errorMessage);

  const { estimatePose } = usePoseEstimation();

  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const handleImageLoad = () => {
    if (imgRef.current) {
      estimatePose(imgRef.current);
    }
  };

  useEffect(() => {
    if (!landmarks || !canvasRef.current || !imgRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set canvas dimensions to match the image dimensions
    canvas.width = imgRef.current.naturalWidth;
    canvas.height = imgRef.current.naturalHeight;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 低 visibility（オクルージョン等）の点はハルシネーション座標のことが
    // 多いため描かない。結線も両端が可視のものだけ描く（#53）
    const drawable = (lm?: (typeof landmarks)[number]) =>
      isVisible(lm, VISIBILITY_GATE.minDraw);
    const visibleLandmarks = landmarks.filter((lm) => drawable(lm));
    const visibleConnections = PoseLandmarker.POSE_CONNECTIONS.filter(
      ({ start, end }) => drawable(landmarks[start]) && drawable(landmarks[end])
    );

    const drawingUtils = new DrawingUtils(ctx);
    drawingUtils.drawLandmarks(visibleLandmarks, {
      radius: (data) => DrawingUtils.lerp(data.from!.z, -0.15, 0.1, 5, 1),
      color: "#ff0000",
    });
    drawingUtils.drawConnectors(landmarks, visibleConnections, {
      color: "#00ff00",
      lineWidth: 4,
    });
  }, [landmarks]);

  if (!imageSrc && !isLoading && !isError) return null;

  return (
    <div className="mt-8">
      {isLoading && (
        <div className="flex items-center justify-center p-4 text-blue-600 font-medium">
          ポーズを推定中...
        </div>
      )}
      {isError && (
        <div className="flex items-center justify-center p-4 text-red-600 font-medium bg-red-50 rounded-lg">
          {errorMessage}
        </div>
      )}

      {imageSrc && (
        <div className="relative inline-block w-full max-w-2xl mx-auto overflow-hidden rounded-lg shadow-lg border border-gray-200">
          <img
            ref={imgRef}
            src={imageSrc}
            alt="Uploaded for pose estimation"
            className="block w-full h-auto object-contain"
            onLoad={handleImageLoad}
            crossOrigin="anonymous"
          />
          {landmarks && (
            <canvas
              ref={canvasRef}
              className="absolute top-0 left-0 w-full h-full pointer-events-none"
              style={{ objectFit: "contain" }}
            />
          )}
        </div>
      )}
    </div>
  );
};
