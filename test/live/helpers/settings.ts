/**
 * プロジェクト設定ツール(カテゴリー・バージョン・状態・カスタム属性)の実環境テスト用の補助。
 * スイート自身が作ったもの(名前に MARK を含む)だけを扱い、既存の設定には触れない。
 * 作ったものは registry に控え、テスト本体が消せなかった場合も cleanupSettings() で必ず消す(afterAll)。
 */
import type { LiveClient } from "./live";
import { DONE_NAMES, world } from "./world";

export type SettingKind = "category" | "version" | "status" | "custom_field";

export const registry: Record<SettingKind, Set<number>> = {
  category: new Set(),
  version: new Set(),
  status: new Set(),
  custom_field: new Set(),
};

const ID_ARG: Record<SettingKind, string> = {
  category: "category_id",
  version: "version_id",
  status: "status_id",
  custom_field: "custom_field_id",
};

const META_TOOL: Record<SettingKind, string> = {
  category: "logbutler_meta_categories",
  version: "logbutler_meta_version",
  status: "logbutler_meta_statuses",
  custom_field: "logbutler_meta_custom_field",
};

/** meta_* の一覧(Backlog の生データ)。 */
export async function listMeta(client: LiveClient, kind: SettingKind, projectKey: string) {
  return (await client.ok(META_TOOL[kind], { project_key: projectKey })) as Array<{
    id: number;
    name: string;
    // biome-ignore lint/suspicious/noExplicitAny: 種別ごとに形が違う Backlog の生データ
    [k: string]: any;
  }>;
}

/**
 * 状態の削除時に課題を移す先。meta_statuses の一覧から、完了集合に入らず、
 * 除外した ID(このスイートが作った状態)でもない既存の状態を選ぶ。ID や並び順は決め打ちしない。
 */
export async function substituteStatusId(
  client: LiveClient,
  projectKey: string,
  excludeIds: readonly number[],
): Promise<number> {
  const statuses = await listMeta(client, "status", projectKey);
  const found = statuses.find((s) => !excludeIds.includes(s.id) && !DONE_NAMES.includes(s.name));
  if (!found) {
    throw new Error(
      `代替にできる既存の状態(完了集合以外)が無い: ${statuses.map((s) => `${s.id}:${s.name}`).join(", ")}`,
    );
  }
  return found.id;
}

/** この実行で作って、まだ消えていないものを消す。失敗は握りつぶさず、最後にまとめて報告する。 */
export async function cleanupSettings(): Promise<string[]> {
  const { client, config } = world();
  const failures: string[] = [];
  // 状態を先に消す(課題を移す先が必要なので、他の種別より手順が重い)。
  const order: SettingKind[] = ["custom_field", "version", "category", "status"];
  for (const kind of order) {
    for (const id of [...registry[kind]]) {
      try {
        const args: Record<string, unknown> = {
          project_key: config.projectKey,
          [ID_ARG[kind]]: id,
        };
        if (kind === "status") {
          args.substitute_status_id = await substituteStatusId(client, config.projectKey, [
            ...registry.status,
          ]);
        }
        const r = await client.call(`logbutler_${kind}_delete`, args);
        if (r.isError) failures.push(`${kind} ${id}: ${client.redact(r.text.slice(0, 200))}`);
        else registry[kind].delete(id);
      } catch (e) {
        failures.push(`${kind} ${id}: ${client.redact(String(e))}`);
      }
    }
  }
  return failures;
}
