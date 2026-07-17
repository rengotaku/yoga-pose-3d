import React, { useEffect, useRef } from "react";
import { DrawingUtils, PoseLandmarker } from "@mediapipe/tasks-vision";
import { usePoseStore } from "../../store/usePoseStore";
import { usePoseEstimation } from "../../hooks/usePoseEstimation";

export const PoseCanvas: React.FC = () => {
  const { imageSrc, landmarks, isLoading, isError, errorMessage } = usePoseStore();
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

    const drawingUtils = new DrawingUtils(ctx);
    drawingUtils.drawLandmarks(landmarks, {
      radius: (data) => DrawingUtils.lerp(data.from!.z, -0.15, 0.1, 5, 1),
      color: "#ff0000",
    });
    drawingUtils.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, {
      color: "#00ff00",
      lineWidth: 4,
    });
  }, [landmarks]);

  if (!imageSrc) return null;

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
    </div>
  );
};
