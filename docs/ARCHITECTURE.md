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
   - **3D**: `PoseViewer3D` が `worldLandmarks` を購読し、Three.js を用いて 3D 空間内にマネキン（関節球と肢体カプセル）を構築し描画します。

## ディレクトリ構成と役割 (Directory Structure)

- `src/components/PoseEstimation/`
  - `ImageUploader.tsx`: 画像のドラッグ＆ドロップ、ファイル選択、サイズ上限・形式バリデーションを担当。
  - `PoseCanvas.tsx`: 画像の表示と、MediaPipe による推論トリガー、2D 骨格のオーバーレイ描画を担当。
- `src/components/PoseViewer3D/`
  - `PoseViewer3D.tsx`: Three.js による 3D 空間の構築、カメラコントロール (`OrbitControls`)、ライティング設定を担当。また、`worldLandmarks` から動的に 3D マネキン（球と円柱による簡易骨格モデル）を生成・更新します。
- `src/hooks/`
  - `usePoseEstimation.ts`: MediaPipe `PoseLandmarker` の初期化と推論処理をカプセル化。非同期ロードや推論中の競合管理、コンポーネントアンマウント時のリソース解放 (`close()`) を担当。
- `src/store/`
  - `usePoseStore.ts`: Zustand によるグローバルな状態管理。UI 状態（ロード中、エラー等）や推論結果（2D/3D 座標データ）を一元管理します。
- `src/pages/`
  - `HomePage.tsx`: アプリケーションのメイン画面。画像のアップロードUIと3Dビューアを2カラムで並べるレイアウトを担当します。

## どこを触れば何が変わるか (Where to modify)

- **3Dマネキンの見た目（色や太さ）を変えたい場合**
  - `src/components/PoseViewer3D/PoseViewer3D.tsx` 内の `generateMannequin` 関数のマテリアル（`MeshStandardMaterial`）やジオメトリ（`SphereGeometry`, `CylinderGeometry`）の設定を変更します。
- **カメラの初期位置やズーム、回転の設定を変えたい場合**
  - 同様に `PoseViewer3D.tsx` 内の `PerspectiveCamera` や `OrbitControls` の設定箇所を変更します。
- **姿勢推定モデルを変更・更新したい場合**
  - `src/hooks/usePoseEstimation.ts` の `MODEL_URL`（Google Cloud StorageのURL）や `PoseLandmarker.createFromOptions` に渡すオプションを変更します。
- **画像アップロードの制限（ファイルサイズ・形式）を変えたい場合**
  - `src/components/PoseEstimation/ImageUploader.tsx` を修正します。
- **レイアウトを変更したい場合**
  - `src/pages/HomePage.tsx` の Tailwind CSS クラスを変更します。
