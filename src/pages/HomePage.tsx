import { ImageUploader, PoseCanvas } from "../components/PoseEstimation";

export function HomePage() {
  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <h1 className="mb-6 text-3xl font-bold tracking-tight text-center">
        ヨガポーズ推定
      </h1>

      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
        <ImageUploader />
        <PoseCanvas />
      </div>
    </div>
  );
}
