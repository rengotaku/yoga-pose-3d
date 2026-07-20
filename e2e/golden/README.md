# e2e/golden

パイプラインを一切通さない、手付けの正解ボーン回転（ゴールデン）。
`make pose-score` / `make golden-check` の入力になる（ADR 0007 / ADR 0008 / ADR 0009）。

## ファイル構成

- `<pose>.json`: ゴールデン本体（`GoldenPose` 型。`src/components/PoseViewer3D/golden.ts` 参照）
- `sources.local.json`（gitignore 済み・**リポジトリにコミットしない**）: 実写真の
  ローカル絶対パスを `{ "<pose>": "/abs/path/to/photo.png" }` で指定する
- `sources.local.json.example`: 上記のテンプレート

## `tier` フィールド（#104, ADR 0009）

各ゴールデン JSON は `tier: "dev" | "holdout"` を持つ:

- **`dev`**: パイプライン改善のチューニング対象として使ってよいポーズ。
  既存 3 ポーズ（tabletop / cross-seat / kneel-sidebend）はすべて `dev`。
- **`holdout`**: 改善作業（プリセット検索・ヒューリスティック調整）から
  意図的に隠し、汎化確認にのみ使うポーズ。dev で高スコアが出ても holdout で
  同程度のスコアが出なければ、dev への過適合を疑う。

`tier` を省略すると `dev` として扱われる（`pose-score.mjs` / `golden-check.mjs` /
`e2e/lib/aggregate.mjs` のデフォルト解決）。

## hold-out ポーズを追加する手順

1. 新しいポーズの実写真を用意し、ローカルパスを `sources.local.json` に追記する
   （リポジトリにはコミットしない）
2. `e2e/golden/<pose>.json` を新規作成し、**`"tier": "holdout"` を明示する**
3. 手付けのボーン回転を作成する（写真とレンダーの目視比較ループ。既存ゴールデンの
   `rotations` / `contacts` / `palmsDown` を参考にする）
4. `make pose-score` を実行し、コンソール出力に `=== summary (holdout) ===`
   セクションが出ることを確認する
5. `make golden-check` で ROM / めり込み / 接地 / 手のひら向き / 写真整合の
   合格を確認する（合格基準は ADR 0008 参照）

## やってはいけないこと

- 既存 3 ポーズ（dev tier）を holdout に変更しない（既存の計測系列との
  比較性が壊れる）
- 実写真を `e2e/golden/` 配下や `sources.local.json` 以外の場所にコミットしない
- CI（GitHub Actions）に `make pose-score` / `make golden-check` を配線しない
  （実写真依存のためローカル実行前提）
