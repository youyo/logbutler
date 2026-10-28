/** Backlog API クライアント。M01 では GET /api/v2/users/myself だけ(M02 で拡張する)。 */

export interface BacklogUser {
  id: number;
  userId: string;
  name: string;
  mailAddress?: string;
  roleType?: number;
}

export interface BacklogClient {
  getMyself(): Promise<BacklogUser>;
}

/** Backlog が 401 を返した。MCP クライアントにトークンをリフレッシュさせる合図。 */
export class BacklogUnauthorizedError extends Error {
  constructor() {
    super("Backlog rejected the access token");
    this.name = "BacklogUnauthorizedError";
  }
}

/** 401 以外の Backlog API エラー(トークンや応答本文は含めない)。 */
export class BacklogApiError extends Error {
  constructor(readonly status: number) {
    super(`Backlog API returned ${status}`);
    this.name = "BacklogApiError";
  }
}

export function createBacklogClient(opts: {
  spaceHost: string;
  accessToken: string;
}): BacklogClient {
  async function get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`https://${opts.spaceHost}/api/v2${path}`, {
        headers: { Authorization: `Bearer ${opts.accessToken}`, Accept: "application/json" },
      });
    } catch {
      // 通信失敗。status 0 は「Backlog に到達できなかった」を表す。
      throw new BacklogApiError(0);
    }
    if (res.status === 401) throw new BacklogUnauthorizedError();
    if (!res.ok) throw new BacklogApiError(res.status);
    return (await res.json()) as T;
  }

  return {
    getMyself: () => get<BacklogUser>("/users/myself"),
  };
}
