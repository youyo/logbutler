import type { RecordedCall } from "./mock-fetch";

/** 分析系テストの「今」。2026-10-28(水)12:00 JST = 03:00 UTC。 */
export const NOW = new Date("2026-10-28T03:00:00Z");

export const iso = (t: Date) => t.toISOString().replace(".000Z", "Z");
/** NOW から days 日(と hours 時間)前。 */
export const ago = (days: number, hours = 0) =>
  iso(new Date(NOW.getTime() - (days * 24 + hours) * 3600_000));

export const USER_A = { id: 1, userId: "a", name: "Alice" };
export const USER_B = { id: 2, userId: "b", name: "Bob" };

export interface IssueSpec {
  key: string;
  status?: string | null;
  statusId?: number;
  priority?: string | null;
  assignee?: { id: number; userId?: string; name: string } | null;
  updated?: string | null;
  created?: string | null;
  dueDate?: string | null;
  summary?: string;
  [extra: string]: unknown;
}

let nextId = 1000;
/** Backlog の課題(生データの camelCase)。status などは名前だけで作れる。 */
export function issue(spec: IssueSpec): Record<string, unknown> {
  const { key, status, statusId, priority, assignee, updated, created, dueDate, summary, ...rest } =
    spec;
  const out: Record<string, unknown> = {
    id: nextId++,
    projectId: 10,
    issueKey: key,
    summary: summary ?? `summary ${key}`,
    status: status === null ? null : { id: statusId ?? 1, name: status ?? "未対応" },
    priority: priority === null ? null : { id: 3, name: priority ?? "中" },
    assignee: assignee === undefined ? null : assignee,
    created: created === undefined ? ago(30) : created,
    updated: updated === undefined ? ago(1) : updated,
    dueDate: dueDate === undefined ? null : dueDate,
    ...rest,
  };
  if (out.created === null) delete out.created;
  if (out.updated === null) delete out.updated;
  return out;
}

/** `GET /issues` の応答。offset / count で全件を切り出す(Backlog のページング)。 */
export function paged<T>(all: readonly T[]) {
  return (call: RecordedCall) => {
    const q = new URL(call.url).searchParams;
    const offset = Number(q.get("offset") ?? 0);
    const count = Number(q.get("count") ?? 20);
    return all.slice(offset, offset + count);
  };
}

/** 何ページ目でも満杯(100 件)を返す。上限で止まることの確認用。 */
export function endless(make: (n: number) => unknown) {
  return (call: RecordedCall) => {
    const offset = Number(new URL(call.url).searchParams.get("offset") ?? 0);
    return Array.from({ length: 100 }, (_, i) => make(offset + i + 1));
  };
}

export interface CommentSpec {
  id: number;
  content?: string;
  user?: { id: number; userId?: string; name: string };
  created?: string;
}
export const comment = (c: CommentSpec) => ({
  id: c.id,
  content: c.content ?? `comment ${c.id}`,
  createdUser: c.user ?? USER_A,
  created: c.created ?? ago(1),
  updated: c.created ?? ago(1),
});

/** コメント一覧(新しい順 = id の降順)。`maxId` / `count` のカーソルで切り出す。ids は total..1。 */
export function commentsDesc(
  total: number,
  make: (id: number) => unknown = (id) => comment({ id }),
) {
  return (call: RecordedCall) => {
    const q = new URL(call.url).searchParams;
    const maxId = q.get("maxId") === null ? total : Math.min(Number(q.get("maxId")), total);
    const count = Number(q.get("count") ?? 20);
    const out: unknown[] = [];
    for (let id = maxId; id >= 1 && out.length < count; id--) out.push(make(id));
    return out;
  };
}

/** 何ページ目でも満杯(100 件)のコメント(id は減り続ける)。 */
export function endlessComments() {
  return (call: RecordedCall) => {
    const q = new URL(call.url).searchParams;
    const maxId = q.get("maxId") === null ? 100_000 : Number(q.get("maxId"));
    return Array.from({ length: 100 }, (_, i) => comment({ id: maxId - i }));
  };
}

export interface ActivitySpec {
  id: number;
  type?: number;
  created?: string;
  user?: { id: number; userId?: string; name: string } | null;
  content?: Record<string, unknown>;
}
export const activity = (a: ActivitySpec) => ({
  id: a.id,
  type: a.type ?? 2,
  created: a.created ?? ago(1),
  createdUser: a.user === undefined ? USER_A : a.user,
  content: a.content ?? {},
});

/** アクティビティ(新しい順 = id の降順)を `maxId` / `count` で切り出す。ids は total..1。 */
export function activitiesDesc(total: number, make: (id: number) => unknown) {
  return (call: RecordedCall) => {
    const q = new URL(call.url).searchParams;
    const maxId = q.get("maxId") === null ? total : Math.min(Number(q.get("maxId")), total);
    const count = Number(q.get("count") ?? 20);
    const out: unknown[] = [];
    for (let id = maxId; id >= 1 && out.length < count; id--) out.push(make(id));
    return out;
  };
}

/** 何ページ目でも満杯(100 件)のアクティビティ(id は減り続ける)。 */
export function endlessActivities(make: (id: number) => unknown) {
  return (call: RecordedCall) => {
    const q = new URL(call.url).searchParams;
    const maxId = q.get("maxId") === null ? 100_000 : Number(q.get("maxId"));
    return Array.from({ length: 100 }, (_, i) => make(maxId - i));
  };
}
