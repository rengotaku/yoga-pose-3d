import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { ImageUploader, PoseCanvas } from "../components/PoseEstimation";
import { PoseViewer3D } from "../components/PoseViewer3D";
import { usePoseStore } from "../store/usePoseStore";

export function HomePage() {
  const worldLandmarks = usePoseStore((s) => s.worldLandmarks);
  // 開閉は「手動トグル」と「推定結果の有無」からの導出値（#59）。
  // 手動トグルはその時点の推定結果に紐づく上書きで、新しい結果が来たら
  // 上書きは失効して自動展開に戻る（effect で setState しないための設計）
  const [manualToggle, setManualToggle] = useState<{
    open: boolean;
    result: unknown;
  } | null>(null);
  const hasResult = !!worldLandmarks && worldLandmarks.length > 0;
  const is3DOpen =
    manualToggle && manualToggle.result === worldLandmarks
      ? manualToggle.open
      : hasResult;

  const viewerSectionRef = useRef<HTMLDivElement>(null);

  // マネキン生成（ポーズ推定完了）時にブロックを画面中央へスクロールする。
  // 展開直後は 3D ビューアのマウントで高さが変わるため少し待ってから寄せる
  useEffect(() => {
    if (!worldLandmarks || worldLandmarks.length === 0) return;
    const id = window.setTimeout(() => {
      viewerSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 100);
    return () => window.clearTimeout(id);
  }, [worldLandmarks]);

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

        <div
          ref={viewerSectionRef}
          className={`bg-white p-6 rounded-xl shadow-sm border border-gray-100 flex flex-col ${
            is3DOpen ? "min-h-[calc(100vh-6rem)]" : ""
          }`}
        >
          <button
            type="button"
            className="flex items-center justify-between w-full text-left cursor-pointer"
            onClick={() => setManualToggle({ open: !is3DOpen, result: worldLandmarks })}
            aria-expanded={is3DOpen}
          >
            <h2 className="text-xl font-semibold">2. 3Dマネキン (360度ビュー)</h2>
            {is3DOpen ? (
              <ChevronUp className="text-gray-400" aria-hidden="true" />
            ) : (
              <ChevronDown className="text-gray-400" aria-hidden="true" />
            )}
          </button>
          {is3DOpen && (
            <div className="flex-grow relative mt-4">
              <PoseViewer3D />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
