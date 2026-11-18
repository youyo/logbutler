/**
 * feedback ツール(ADR 0019)の匿名化ルールのうち、Backlog 固有の部分(共通仕様 §7.2)。
 * 共通の部分は guide.ts。ほかの製品のリポジトリへ写すときは、このファイルを製品ごとに差し替える。
 */
import { ERROR_CODES } from "../errors";

/** Backlog 固有のプレースホルダ。共通の `<USER>` `<EMAIL>` `<ORG>` `<HOST>` `<URL>` `<ID>` に続けて返す。 */
export const BACKLOG_PLACEHOLDERS = ["<SPACE>", "<PROJECT_KEY>", "<ISSUE_KEY>"] as const;

/**
 * Backlog 固有の匿名化ルール。共通のルールに続けて返す。プレースホルダはバッククォートで囲む。
 * 残してよい固定のエラーコードは src/errors.ts の ERROR_CODES(ツールのエラーのエンベロープの code)。
 */
export const BACKLOG_ANONYMIZATION_RULES: readonly string[] = [
  "Backlog のスペース名と URL（`*.backlog.com` `*.backlog.jp`）は `<SPACE>` にする",
  "プロジェクトキーは `<PROJECT_KEY>` にする",
  "課題キー（`ABC-123` の形）は `<ISSUE_KEY>` にする",
  "Wiki・ドキュメントの名前も伏せる",
  `残してよい公開固定値は、logbutler の公開ツール名と、固定のエラーコード（${ERROR_CODES.map((c) => `\`${c}\``).join(" ")}）`,
];
