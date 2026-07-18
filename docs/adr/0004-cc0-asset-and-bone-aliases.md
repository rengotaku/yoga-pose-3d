# ADR 0004: マネキンアセットの CC0 化とボーン命名の別名解決

- Status: Accepted
- Date: 2026-07-18
- Refs: #24, #29, PR #34（関連: ADR 0003）

## 文脈

ADR 0003 で採用した Xbot.glb は Mixamo 由来で、three.js examples 同梱実績はあるものの再配布の厳密なクリアランスが無かった（#24 バックログ6）。ライセンス厳密化のため CC0 アセットへ差し替える。

## 決定

1. **アセット**: [Mesh2Motion/mesh2motion-app](https://github.com/Mesh2Motion/mesh2motion-app) 配布の `human-base.glb`（原作 Quaternius）を採用し `public/models/mannequin.glb` として同梱する。
   - ライセンス根拠（3点で確認）: 同リポジトリ README「Licenses」節 / `LICENSE-CC0.MD` / `src/lib/RigModelVariations.ts` の `{attribution: 'Quaternius', license: 'CC0'}`（他モデルは CC-BY/CC-SA と区別記載）
   - 534KB・66 ジョイント・スキンメッシュ。造形は解剖学的マネキンで「人と分かる」水準（#8 の目標）を実画面確認済み
2. **ボーン解決**: スケルトンは UE 系命名（pelvis / spine_01 / upperarm_l 等）のため、`resolveBoneName` を「mixamorig サフィックス一致 → `BONE_ALIASES` **完全一致**」の2段解決に拡張する。
   - 完全一致にするのは `head_leaf` 等の末端ヘルパーボーンへの誤マッチ（endsWith の副作用）を防ぐため
3. **筋マッピング**: `canonicalizeBoneName` が UE 系名を mixamorig 風正準名（upperarm_l → LeftArm）へ写像してから既存の筋群判定に流す。左右判定は `_l`/`_r` サフィックスにも対応。

## 却下した代替案

- **Sketchfab の CC0 モデル**: 要ログインで直リンク DL 不可（#22 当時と同じ理由）
- **OpenGameArt の Low Poly Character**: .blend のみで Blender エクスポート工程が必要、スキニング品質未検証
- **筋群判定側を UE 系名で分岐追加**: 判定ロジックに命名分岐が散らばる。正準化1関数に集約する方が保守しやすい

## 変えてよい前提 / 壊すと危ない前提

- ✅ 変えてよい: アセット実体（`BONE_ALIASES` に別名を足せば他のリグ付きヒューマノイドへ差し替え可能。mixamorig 互換も引き続き動く）
- ⚠️ 壊すと危ない: `BONE_ALIASES` のキーは mixamorig サフィックス（`LIMB_BONE_MAPPINGS` 等のキーと対応）。キー体系を変えるとリターゲット・筋マッピング両方が壊れる
- ⚠️ 壊すと危ない: 別名解決を endsWith に緩めると末端ヘルパー（head_leaf / ball_leaf_*）へ誤マッチする
