# e2e/golden

パイプラインを一切通さない、手付けの正解ボーン回転（ゴールデン）。
`make pose-score` / `make golden-check` の入力になる（ADR 0007 / ADR 0008 / ADR 0009）。

## ファイル構成

- `<pose>.json`: ゴールデン本体（`GoldenPose` 型。`src/components/PoseViewer3D/golden.ts` 参照）
- `photos/<pose>.png`: 実写真（**committed**。ADR 0010 で in-repo 管理に移行、private repo 前提）
- `sources.json`（committed）: pose → 写真パスの default 対応表（`./photos/<pose>.png` 参照）
- `sources.local.json`（gitignore 済み・ローカル上書き用）: 別マシンでの絶対パス指定や、
  実験用に別写真で試したい時のエスケープハッチ。同じ pose キーがあればこちらが優先される
- `sources.local.json.example`: `sources.local.json` を書き起こす際のテンプレート

参照優先順位: **`sources.local.json` が存在すれば優先**、無ければ `sources.json`。両方に
同じ pose キーがあればローカル上書きが勝つ。相対パスは `e2e/golden/` 基準で解決される
（`./photos/tabletop.png` → `e2e/golden/photos/tabletop.png`）。

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

1. **実写真を用意し `e2e/golden/photos/<pose>.png` に配置**する
   （ADR 0010 で in-repo 管理へ移行済み・private repo 前提）:

   ```bash
   cp /path/to/your/photo.png e2e/golden/photos/standing-tree.png
   ```

   `sources.json` に対応するエントリを追加する（相対パスで committed）:

   ```jsonc
   {
     "tabletop": "./photos/tabletop.png",
     "cross-seat": "./photos/cross-seat.png",
     "kneel-sidebend": "./photos/kneel-sidebend.png",
     "standing-tree": "./photos/standing-tree.png"   // ← 追加
   }
   ```

   別マシンで一時的に絶対パスで上書きしたい場合のみ `sources.local.json`
   （gitignore 済み）に該当 pose キーを書く。両方にあればローカル上書きが勝つ。

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
- **リポジトリを public のまま `photos/` を残さない**（ADR 0010）。public 化する
  なら `photos/` を git 履歴から完全に除去 → `sources.local.json` 運用へ戻す →
  ADR を棄却する新 ADR を書く、の 3 点を必ずセットで実施する
- 実写真を **再配布・共有** しない（Slack / 他 repo / 公開 gist / スクショの再掲を含む）。
  private repo 内の私的利用に限定する
- CI（GitHub Actions）に `make pose-score` / `make golden-check` を配線しない
  （playwright + dev サーバ依存のためローカル実行前提）
