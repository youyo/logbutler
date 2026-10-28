/** スイート全体で共有する状態(接続と、実行時に取得したプロジェクトの設定値)。 */
import { readFileSync } from "node:fs";
import { type LiveClient, type LiveConfig, loadConfig } from "./live";

export interface Status {
  id: number;
  name: string;
}

export interface World {
  config: LiveConfig;
  client: LiveClient;
  projectId: number;
  /** 接続先のスペース(logbutler_space_info の spaceKey)。アカウント固有値をテストに書かないため実行時に取得する。 */
  spaceKey: string;
  /** 認証ユーザー(logbutler_user_me)。 */
  meId: number;
  issueTypeId: number;
  statuses: Status[];
  /** 課題の状態遷移に使う 3 つ。標準状態の名前・ID・順序は前提にせず、取得した一覧から、完了集合(DONE_NAMES)に入る 1 つと、入らないものの先頭 2 つを選ぶだけ。 */
  openStatus: Status;
  midStatus: Status;
  doneStatus: Status;
  /** プロジェクトの課題で使われている優先度(GET /priorities はツールにないので、課題の値から集める)。 */
  priorityIds: number[];
  /** スナップショットのツール定義(名前・読み取り専用か)。 */
  snapshotTools: Array<{ name: string; readOnly: boolean }>;
}

/** 完了とみなす状態名(src/analysis/statuses.ts の DONE_STATUSES と同じ。ロードマップの決定事項)。 */
export const DONE_NAMES = ["完了", "対応済み", "Closed", "Done", "Resolved"];

let current: World | undefined;

export function setWorld(w: World): void {
  current = w;
}

export function world(): World {
  if (!current) {
    loadConfig(); // 必須の環境変数が未設定なら、その理由を明示して失敗させる
    throw new Error("world が未初期化(setup の suite が失敗している)");
  }
  return current;
}

export function config(): LiveConfig {
  return loadConfig();
}

export function loadSnapshotTools(): World["snapshotTools"] {
  const raw = JSON.parse(readFileSync("test/snapshots/tools_list.json", "utf8"));
  const tools = (Array.isArray(raw) ? raw : raw.tools) as Array<{
    name: string;
    annotations?: { readOnlyHint?: boolean };
  }>;
  return tools.map((t) => ({ name: t.name, readOnly: t.annotations?.readOnlyHint === true }));
}

/**
 * live の対象外(ユーザー決定)。呼び出しも期待値も書かない。tools/list に存在することだけ確かめる。
 * - 共有ファイル: 2FA 設定時に別パスワードが必要になるため。
 * - Wiki: このスペースで有効化できない(Backlog 側で EOL)ため。ユーザーが別環境で試し、不具合は issue にする。
 */
export const OUT_OF_SCOPE: Record<string, string> = {
  logbutler_shared_file_list: "共有ファイル: 2FA 設定時に別パスワードが必要",
  logbutler_shared_file_download: "共有ファイル: 2FA 設定時に別パスワードが必要",
  logbutler_wiki_sharedfile_list: "共有ファイル/Wiki: 2FA 別パスワード・Wiki 有効化不可",
  logbutler_wiki_attachment_list: "Wiki: このスペースで有効化できない(Backlog 側で EOL)",
  logbutler_wiki_count: "Wiki: このスペースで有効化できない(Backlog 側で EOL)",
  logbutler_wiki_get: "Wiki: このスペースで有効化できない(Backlog 側で EOL)",
  logbutler_wiki_history: "Wiki: このスペースで有効化できない(Backlog 側で EOL)",
  logbutler_wiki_list: "Wiki: このスペースで有効化できない(Backlog 側で EOL)",
  logbutler_wiki_stars: "Wiki: このスペースで有効化できない(Backlog 側で EOL)",
  logbutler_wiki_tags: "Wiki: このスペースで有効化できない(Backlog 側で EOL)",
};
