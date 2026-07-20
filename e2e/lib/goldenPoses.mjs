/**
 * `e2e/golden/` 配下のファイル名一覧から「ポーズ本体の JSON」だけを抽出する（#108）。
 *
 * ポーズ本体でない JSON ファイルの除外規則:
 *   - "_" 始まり: サンプル（`_sample.json` 等。goldenPoses.ts の除外規則と同じ）
 *   - `NON_POSE_JSON` に入っているファイル: `sources.json`（#106 で追加した写真パス表）
 *   - `.local.` を含む: `sources.local.json`（gitignore 対象のローカル上書き）
 *   - `.example` で終わる: `sources.local.json.example` などのテンプレート
 *
 * この除外を怠ると golden-check の全件モードが sources.json を "sources" という
 * ポーズ名で拾い、GoldenPose の rotations が無くて実行時に壊れる（Codex stop-time
 * review で検出された実バグ）。
 */

/** ポーズ本体ではない .json ファイル名の明示リスト */
export const NON_POSE_JSON = new Set(["sources.json", "sources.local.json"]);

/**
 * ディレクトリ内のファイル名配列から、ポーズ ID（ファイル名から .json を除いたもの）
 * だけを取り出す。順序は入力順を保つ。
 * @param {string[]} filenames - readdirSync 由来のファイル名（ディレクトリ名含まず）
 * @returns {string[]} pose ID のリスト
 */
export const listPoseIds = (filenames) =>
  filenames
    .filter(
      (f) =>
        f.endsWith(".json") &&
        !f.startsWith("_") &&
        !NON_POSE_JSON.has(f) &&
        !f.includes(".local.") &&
        !f.endsWith(".example")
    )
    .map((f) => f.slice(0, -".json".length));
