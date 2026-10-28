/** スイートが作る課題の共有状態。後続の suite(分析・digest)も使う。 */
export interface LiveIssue {
  id: number;
  key: string;
  summary: string;
}

export const created: {
  main?: LiveIssue;
  related?: LiveIssue;
  child?: LiveIssue;
  overdue?: LiveIssue;
  commentIds: number[];
  /** この実行で作った課題・ドキュメントなど(報告用)。 */
  log: string[];
} = { commentIds: [], log: [] };

export function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`前提が揃っていない: ${what}(先行するテストの失敗)`);
  return v;
}

/** 秒単位の遅延(Backlog 側の反映待ちが要る箇所だけで使う)。 */
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** UTC の日付に日数を足して YYYY-MM-DD にする。 */
export function ymd(offsetDays = 0, base = new Date()): string {
  const t = new Date(base.getTime() + offsetDays * 86_400_000);
  return t.toISOString().slice(0, 10);
}

/** 東京の「今日」(YYYY-MM-DD)。 */
export function todayTokyo(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** 検索インデックスの反映待ち(Backlog のキーワード検索は結果整合)。条件を満たすまで間隔を空けて再取得する。 */
export async function pollFor<T>(
  fetcher: () => Promise<T>,
  done: (v: T) => boolean,
  // Backlog の検索インデックスへの反映は 30 秒を超えることがある(2026-10-29 実測)。最大約 2 分待つ。
  tries = 30,
  delayMs = 4000,
): Promise<T> {
  let last = await fetcher();
  for (let i = 1; i < tries && !done(last); i++) {
    await sleep(delayMs);
    last = await fetcher();
  }
  return last;
}
