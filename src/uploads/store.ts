/**
 * 添付アップロードの URL 経路(ADR 0018)の、R2 上の置き場所と ticket。
 *
 * - `ticket/<id>`: prepare が発行する。`{uid, expiresAt}`。expiresAt は PUT の受付期限(prepare から 60 秒)。
 * - `data/<id>`: PUT /uploads/<id> の本文。「存在しなければ」の条件付き put で 1 回だけ書ける。
 * - `claim/<id>`: 完了処理の状態(src/uploads/attach.ts)。削除せず、条件付き put だけで遷移する。
 *
 * どれも R2 のライフサイクルルールで 1 日後に消す(runbook の必須手順)。upload_id は秘密の capability なので、
 * ログにも KV(`idem:` など)にも出さない。
 */

import { LogbutlerError } from "../errors";

/** URL 経由で受け付けるファイルの上限。ダウンロードの上限(ADR 0004)と同じ 20 MiB。 */
export const MAX_URL_UPLOAD_BYTES = 20 * 1024 * 1024;
/** PUT の受付期限(prepare から。ticket の expiresAt)。判定は本文を読む前で、転送が長引いても受付は切れない。 */
export const UPLOAD_PUT_WINDOW_MS = 60 * 1000;
/** 完了の期限(data の保存時刻 = R2 の `uploaded` から)。claim が無いときだけ見る。 */
export const COMPLETE_WINDOW_MS = 15 * 60 * 1000;
/** 完了処理の lease。claimedAt からこの時間を過ぎた claimed は、別の呼び出しが引き継げる。 */
export const CLAIM_LEASE_MS = 2 * 60 * 1000;

/** 256bit の乱数を base64url(パディングなし)にした 43 文字。 */
const UPLOAD_ID = /^[A-Za-z0-9_-]{43}$/;

export function isUploadId(id: string): boolean {
  return UPLOAD_ID.test(id);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** upload_id(256bit の乱数)。 */
export function newUploadId(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** 試行ごとの乱数(claim の本文に入れ、同じ内容の put で etag が元に戻るのを防ぐ)。 */
export function newNonce(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

export function uploadKeys(id: string) {
  return { ticket: `ticket/${id}`, data: `data/${id}`, claim: `claim/${id}` } as const;
}

/** 発行した ticket。uid は Backlog のユーザー ID(1 Worker = 1 スペースなので、uid だけで照合する)。 */
export interface UploadTicket {
  uid: number;
  /** 期限(エポックミリ秒)。 */
  expiresAt: number;
}

/** 新しい upload_id を発行し、ticket を R2 に置く。 */
export async function createUploadTicket(
  bucket: R2Bucket,
  uid: number,
  now: Date,
): Promise<{ id: string; expiresAt: Date }> {
  const id = newUploadId();
  const expiresAt = now.getTime() + UPLOAD_PUT_WINDOW_MS;
  const ticket: UploadTicket = { uid, expiresAt };
  await bucket.put(uploadKeys(id).ticket, JSON.stringify(ticket));
  return { id, expiresAt: new Date(expiresAt) };
}

/** ticket を読む。無い・壊れているなら null。 */
export async function readUploadTicket(bucket: R2Bucket, id: string): Promise<UploadTicket | null> {
  const obj = await bucket.get(uploadKeys(id).ticket);
  if (!obj) return null;
  try {
    const t = JSON.parse(await obj.text()) as Partial<UploadTicket>;
    if (typeof t.uid !== "number" || typeof t.expiresAt !== "number") return null;
    return { uid: t.uid, expiresAt: t.expiresAt };
  } catch {
    return null;
  }
}

/** PUT の受付期限内か(期限ちょうどは切れとみなす)。 */
export function isTicketLive(ticket: UploadTicket, nowMs: number): boolean {
  return nowMs < ticket.expiresAt;
}

/** `{PUBLIC_BASE_URL}/uploads/<id>` */
export function uploadUrl(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/uploads/${id}`;
}

/**
 * R2 の想定外の失敗を、再試行できるエラーにする。R2 の例外の文面にはキー(= upload_id)が入りうるので、
 * ログには例外名だけを出し、応答にも文面を載せない。LogbutlerError(Backlog のエラーなど)はそのまま返す。
 */
export function asUploadError(e: unknown): LogbutlerError {
  if (e instanceof LogbutlerError) return e;
  console.error(
    JSON.stringify({
      event: "upload_storage_failed",
      error: e instanceof Error ? e.name : typeof e,
    }),
  );
  return new LogbutlerError(
    "generic_error",
    "The upload storage is temporarily unavailable. Retry with the same arguments.",
    true,
  );
}
