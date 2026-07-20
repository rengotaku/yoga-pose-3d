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

### 命名規則

- ファイル名は `<pose>.json`（kebab-case、英小文字）。命名は「体位＋特徴」の
  組み合わせで検索性を確保する（例: `standing-tree`、`seated-twist-right`、
  `plank-side`、`fold-forward`）。ID 番号や日付は付けない。
- `_` で始まる名前はサンプル・除外扱い（`_sample.json` は `goldenPoses.ts`
  の除外規則と `golden-check.mjs` のポーズ列挙対象外）。

### JSON の最小例（hold-out）

```jsonc
{
  "pose": "standing-tree",
  "description": "立位・木のポーズ（片脚立ち、足裏を反対脚の内腿に当て、両手は胸前合掌）",
  "tier": "holdout",
  "rotations": {
    "Hips":        [0, 0, 0],
    "Spine":       [0, 0, 0],
    "LeftUpLeg":   [90, 0, 20],
    "LeftLeg":     [-140, 0, 0],
    "RightUpLeg":  [0, 0, 0],
    "RightLeg":    [0, 0, 0]
    // ... 他のボーンは省略（未指定はバインドポーズ）
  },
  "contacts": ["foot:R"],
  "palmsDown": []
}
```

`rotations` は mixamorig 標準名（`src/components/PoseViewer3D/retarget.ts` の
`BONE_ALIASES` のキー）で、バインドポーズからの相対 Euler（XYZ オーダー、度）。

### 手順

1. **実写真を用意**し、ローカル絶対パスを `sources.local.json` に追記する
   （リポジトリにはコミットしない。gitignore 済み）:

   ```jsonc
   {
     "tabletop": "/home/user/Pictures/tabletop.png",
     "cross-seat": "/home/user/Pictures/cross-seat.png",
     "kneel-sidebend": "/home/user/Pictures/kneel.png",
     "standing-tree": "/home/user/Pictures/tree.png"   // ← 追加
   }
   ```

2. **`e2e/golden/<pose>.json` を新規作成**し、上記の最小例に沿って
   **`"tier": "holdout"` を明示**する。`tier` を省略すると `dev` 扱いになり、
   過適合検出の意味が壊れるため必ず明示する（`e2e/lib/aggregate.mjs` の
   `splitByTier` は "dev" / "holdout" 以外の値を throw する）。

3. **手付けのボーン回転を作成**する（写真とレンダーの目視比較ループ）:

   ```bash
   make run          # 別ターミナルで dev サーバ起動
   # ブラウザで /golden にアクセスし、対象 pose を選んでスライダー/ギズモで調整
   # 完了したら export ボタンで <pose>.json を上書き保存する
   ```

4. **単一ポーズで pose-score を確認**する（`POSE=<pose>` で対象を絞る）:

   ```bash
   make pose-score POSE=standing-tree               # 表示のみ
   make pose-score POSE=standing-tree JSON=/tmp/x.json   # JSON も併記
   ```

   コンソール出力に `=== summary (holdout) ===` セクションが出ることを確認
   する（dev / holdout の混在時は両方のセクションが出る）。

5. **`make golden-check` で品質ゲート**（ROM / めり込み / 接地 / 手のひら
   向き / 写真整合）を確認する:

   ```bash
   make golden-check POSE=standing-tree
   make golden-check POSE=standing-tree JSON=/tmp/y.json
   ```

   合格基準（coverage ≧ 4/9・系統 ≧ 2/5・平均角度差 ≦ 20°・各セグメント
   ≦ 35°）は ADR 0008 参照。coverage ゲートで FAIL するようなら、
   写真の撮影視点を変えるか、self-occlusion の少ない写真に差し替える。

## やってはいけないこと

- 既存 3 ポーズ（dev tier）を holdout に変更しない（既存の計測系列との
  比較性が壊れる）
- 実写真を `e2e/golden/` 配下や `sources.local.json` 以外の場所にコミットしない
- CI（GitHub Actions）に `make pose-score` / `make golden-check` を配線しない
  （実写真依存のためローカル実行前提）
