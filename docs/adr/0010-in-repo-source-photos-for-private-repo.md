# ADR 0010: 実写真の in-repo 管理（private repo 前提）

## ステータス

採用（#71 / #106）

## 背景

#71 の「置いた前提」節では、pose-score / golden-check の入力となる実写真を
「動画スクショのため著作権上の配慮でリポジトリにはコミットしない」と規定し、
`e2e/golden/sources.local.json`（gitignore 済み）にローカル絶対パスを書く運用に
していた。

実運用してみて次の摩擦が顕在化:

- マシンをまたぐと `sources.local.json` を毎回作り直す必要がある
- worktree を切るたび `sources.local.json` を手動 or `cp` で移送しないと `make pose-score` が動かない
- hold-out ポーズを追加するたび写真パスの管理が積み上がる
- 実測結果が「その時のローカル写真」に依存し、複数人・複数マシン間で再現性が落ちる

方針としてもう一段整理する。

## 決定

**リポジトリが private である前提のもとで、実写真を `e2e/golden/photos/` に
配置して git 管理する**。private 前提を破る（public 化する）場合は本 ADR を
再検討する。

- **保存場所**: `e2e/golden/photos/<pose>.png`
- **参照**: `e2e/golden/sources.json`（committed）に `{ "<pose>": "./photos/<pose>.png" }` の対応表
- **ローカル上書き**: `e2e/golden/sources.local.json`（gitignore 済み）が存在すれば
  それが優先。同じ pose キーがあればローカル上書き、無ければ `sources.json` を使う。
  実験用に別の写真で試したい・別マシンの絶対パスを指したい時のエスケープハッチ
- **相対パス解決**: `sources.json` / `sources.local.json` の値が相対パスなら
  `e2e/golden/` を基準に絶対化する（両ファイルの並び順は変わらない）

### なぜコミットしてよいと判断したか

- リポジトリは **private** で GitHub の閲覧権限は所有者のみ
- 用途は **私的な研究**（3D マネキン精度の計測 / 改善）で、再配布・公開はしない
- 写真は 3〜数十枚規模で、通常 git のバイナリでも十分（LFS はまだ要らない）
- 「動画スクショの著作権配慮」は public repo でこそ重い制約であり、private 内での
  私的利用に対しては現実的なリスクが低いと判断

### やらないこと（重要）

- **リポジトリを public にしたまま写真を残さない**。public 化するなら以下を全て済ませる:
  1. `e2e/golden/photos/` を git 履歴から完全に取り除く（`git filter-repo` 等。GitHub の
     キャッシュ・fork も含めて対応が必要）
  2. `sources.json` を削除、`sources.local.json` 運用に戻す
  3. 本 ADR を「棄却」に更新する
- 写真を **再配布・共有** しない（Slack / 他 repo / 公開 gist / スクショの再掲を含む）
- **CI で pose-score / golden-check を回さない**（playwright + dev サーバ依存の制約は不変）

## 影響範囲

- `e2e/golden/photos/`（新規ディレクトリ）+ 3 枚の写真（tabletop / cross-seat / kneel-sidebend）
- `e2e/golden/sources.json`（新規、committed）
- `e2e/pose-score.mjs` / `e2e/golden-check.mjs`: sources.json → sources.local.json の順で
  マージロード。相対パス対応
- `e2e/golden/README.md`: 「やってはいけないこと」の該当条項を差し替え
- `docs/ARCHITECTURE.md`: 「精度評価 (Golden Metrics)」節の実写真の説明を更新
- `.gitignore`: 変更なし（`sources.local.json` はそのまま除外。`photos/` は対象外）

## 未解決事項

- **hold-out ポーズ写真の追加運用**: 本 ADR は仕組みだけ規定。実際の hold-out
  ポーズ写真の追加は別 sub-issue（写真調達 + golden JSON 手付け）で扱う
- **LFS 化の閾値**: 写真枚数が 20 枚超えるか、1 枚 5MB を超えるようなら LFS 化を
  検討する。それまで通常 git で運用
- **将来の public 化シナリオ**: 業務化などで public にする必要が出た場合は、
  写真をリポから外し（filter-repo）、CC0 ライセンス素材か自撮り素材に置き換える。
  それが決まる時点で本 ADR を棄却する新 ADR を書く
