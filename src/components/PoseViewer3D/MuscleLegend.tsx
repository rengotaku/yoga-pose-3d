import React from "react";
import { heatColor, type MuscleId } from "./muscles";

export type MuscleActivation = { id: MuscleId; label: string; value: number };

const cssColor = (value: number): string => `#${heatColor(value).color.getHexString()}`;

/**
 * 使用筋のヒートを一覧表示する凡例パネル。
 * 3Dボディの色（ベージュ→オレンジ→赤）と対応する。
 */
export const MuscleLegend: React.FC<{ activations: MuscleActivation[] }> = ({
  activations,
}) => {
  const sorted = [...activations].sort((a, b) => b.value - a.value);
  return (
    <div className="w-full rounded-lg bg-white border border-gray-200 p-3 text-xs">
      <div className="font-semibold text-gray-700 mb-2">使用筋（推定）</div>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
        {sorted.map((m) => (
          <li key={m.id} className="flex items-center gap-2">
            <span
              className="inline-block w-3 h-3 rounded-sm shrink-0 border border-black/10"
              style={{ backgroundColor: cssColor(m.value) }}
            />
            <span className="w-32 text-gray-700 truncate">{m.label}</span>
            <span
              className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden"
              aria-hidden
            >
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${Math.round(m.value * 100)}%`,
                  backgroundColor: cssColor(m.value),
                }}
              />
            </span>
            <span className="tabular-nums text-gray-500 w-8 text-right">
              {Math.round(m.value * 100)}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-2 pt-2 border-t border-gray-100 text-[10px] leading-tight text-gray-400">
        関節角度からの幾何推定。EMG 実測ではありません。
      </div>
    </div>
  );
};
