# Architecture

## システム構成 (Architecture Overview)

本システムは React, TypeScript, Vite で構成された Single Page Application (SPA) です。状態管理に Zustand を用い、MediaPipe による姿勢推定（2D/3D）と、Three.js による 3D モデルの描画を行っています。バックエンドサーバは持たず、全ての処理はブラウザ上で完結します（WASMとモデルファイルのみCDNから取得）。

## データフロー (Data Flow)

1. **ユーザー入力 (UI)**
   - ユーザーが `ImageUploader` から画像をアップロードします。
2. **状態管理 (Zustand Store)**
   - `usePoseStore` がアップロードされた画像URL (`imageSrc`) を保持します。
3. **姿勢推定 (MediaPipe)**
   - 画像が読み込まれると、`PoseCanvas` が `usePoseEstimation` フックを通じて `PoseLandmarker.detect()` を呼び出し、画像の推論を行います。
   - 推論結果（2D `landmarks`, 3D `worldLandmarks`）は再び `usePoseStore` に格納されます。
4. **結果の描画 (2D / 3D)**
   - **2D**: `PoseCanvas` が `landmarks` を購読し、元画像の上にオーバーレイとして骨格を描画します。
   - **3D**: `PoseViewer3D` が `worldLandmarks` を購読し、Three.js を用いて 3D 空間内に肉付き筋肉ボディ（胴体メッシュ + 肢体カプセル + 関節球）を構築し描画します。各部位は使用筋アクティベーション（`muscles.ts` が関節角度から推定）でヒートマップ着色されます。
   - **使用筋の凡例**: `PoseViewer3D` は `aggregateByMuscle` で筋群別アクティベーションを算出し、3Dビューの下に `MuscleLegend` として一覧表示します（EMG 実測ではなく幾何推定）。

## ディレクトリ構成と役割 (Directory Structure)

- `src/components/PoseEstimation/`
  - `ImageUploader.tsx`: 画像のドラッグ＆ドロップ、ファイル選択、サイズ上限・形式バリデーションを担当。
  - `PoseCanvas.tsx`: 画像の表示と、MediaPipe による推論トリガー、2D 骨格のオーバーレイ描画を担当。
- `src/components/PoseViewer3D/`
  - `PoseViewer3D.tsx`: Three.js による 3D 空間の構築、カメラコントロール (`OrbitControls`)、ライティング設定を担当。`worldLandmarks` から肉付きボディを生成・更新し、下部に使用筋凡例を表示します。
  - `mannequin.ts`: `worldLandmarks` から肉付き筋肉ボディ（胴体シリンダー + 肢体カプセル + 関節球）を生成する `generateMannequin`。各部位を使用筋アクティベーションでヒート着色します。
  - `muscles.ts`: 関節角度・分節ベクトルから 8 筋群のアクティベーション（0..1）を推定する純粋関数群（`computeActivations` / `aggregateByMuscle`）とヒート色変換（`heatColor`）。ヒューリスティック（EMG 実測ではない）。
  - `MuscleLegend.tsx`: 使用筋を色付きバーで一覧表示する凡例パネル（3Dビューの外・下に配置）。
- `src/hooks/`
  - `usePoseEstimation.ts`: MediaPipe `PoseLandmarker` の初期化と推論処理をカプセル化。非同期ロードや推論中の競合管理、コンポーネントアンマウント時のリソース解放 (`close()`) を担当。
- `src/store/`
  - `usePoseStore.ts`: Zustand によるグローバルな状態管理。UI 状態（ロード中、エラー等）や推論結果（2D/3D 座標データ）を一元管理します。
- `src/pages/`
  - `HomePage.tsx`: アプリケーションのメイン画面。画像のアップロードUIと3Dビューアを2カラムで並べるレイアウトを担当します。

## どこを触れば何が変わるか (Where to modify)

- **肉付きボディの見た目（色・太さ・体積）を変えたい場合**
  - `src/components/PoseViewer3D/mannequin.ts` の `heatMaterial` / `addLimb`（カプセル半径）/ `addTorso`（胴体シリンダー）を変更します。
- **使用筋の推定ロジック・ヒート色を変えたい場合**
  - `src/components/PoseViewer3D/muscles.ts` の `computeActivations`（関節角度→筋群アクティベーション）や `heatColor`（色域）を変更します。筋群の追加は `MuscleId` / `MUSCLE_LABELS` / `MUSCLE_ORDER` に定義を足します。
- **カメラの初期位置やズーム、回転の設定を変えたい場合**
  - 同様に `PoseViewer3D.tsx` 内の `PerspectiveCamera` や `OrbitControls` の設定箇所を変更します。
- **姿勢推定モデルを変更・更新したい場合**
  - `src/hooks/usePoseEstimation.ts` の `MODEL_URL`（Google Cloud StorageのURL）や `PoseLandmarker.createFromOptions` に渡すオプションを変更します。
- **画像アップロードの制限（ファイルサイズ・形式）を変えたい場合**
  - `src/components/PoseEstimation/ImageUploader.tsx` を修正します。
- **レイアウトを変更したい場合**
  - `src/pages/HomePage.tsx` の Tailwind CSS クラスを変更します。
