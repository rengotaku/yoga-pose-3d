import { ImageUploader, PoseCanvas } from "../components/PoseEstimation";
import { PoseViewer3D } from "../components/PoseViewer3D";

export function HomePage() {
  return (
    <div className="w-full max-w-7xl mx-auto py-8 px-4">
      <h1 className="mb-6 text-3xl font-bold tracking-tight text-center">
        ヨガポーズ推定
      </h1>

      <div className="flex flex-col gap-8">
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 flex flex-col">
          <h2 className="text-xl font-semibold mb-4">1. 画像のアップロード</h2>
          <ImageUploader />
          <PoseCanvas />
        </div>

        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 flex flex-col min-h-[80vh]">
          <h2 className="text-xl font-semibold mb-4">2. 3Dマネキン (360度ビュー)</h2>
          <div className="flex-grow relative">
            <PoseViewer3D />
          </div>
        </div>
      </div>
    </div>
  );
}
