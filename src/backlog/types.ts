/**
 * Backlog API のレスポンス型。Backlog が返す camelCase のまま型を付け、変換しない(ADR 0004)。
 * ツールごとの型は、そのツールを移植するマイルストーンでここに足す。
 */

export interface BacklogUser {
  id: number;
  userId: string;
  name: string;
  mailAddress?: string;
  roleType?: number;
}

/** Backlog のエラー応答 `{"errors":[{"message","code","moreInfo"}]}`。 */
export interface BacklogErrorBody {
  errors?: { message?: string; code?: number; moreInfo?: string }[];
}
