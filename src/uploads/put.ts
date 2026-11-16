/**
 * PUT /uploads/:id(ADR 0018)。prepare が発行した秘密の URL に、クライアントの shell が `curl -T` で本文を送る。
 * OAuth の外側(URL そのものが capability)。判定は仕様の順序どおり、本文を読む前に弾けるものはすべて先に弾く。
 * ID はログに出さない。
 */
import {
  asUploadError,
  isTicketLive,
  isUploadId,
  MAX_URL_UPLOAD_BYTES,
  readUploadTicket,
  uploadKeys,
} from "./store";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function reply(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

const notFound = () => reply(404, { error: "not_found" });

/** R2 の想定外の失敗は 503。例外の文面(キー = upload_id を含みうる)はログにも応答にも出さない。 */
export async function handleUploadPut(
  request: Request,
  bucket: R2Bucket | undefined,
  id: string,
  nowMs: number,
): Promise<Response> {
  try {
    return await handle(request, bucket, id, nowMs);
  } catch (e) {
    asUploadError(e); // 例外名だけをログに出す
    return reply(503, { error: "storage_unavailable" });
  }
}

async function handle(
  request: Request,
  bucket: R2Bucket | undefined,
  id: string,
  nowMs: number,
): Promise<Response> {
  // 1. binding が無い Worker では、この経路は存在しない。
  if (!bucket) return notFound();
  // 2. 形式が不正な ID は R2 を読まずに返す。
  if (!isUploadId(id)) return notFound();
  // 3. 未発行・期限切れ(存在するかどうかは教えない)。
  const ticket = await readUploadTicket(bucket, id);
  if (!ticket || !isTicketLive(ticket, nowMs)) return notFound();

  // 4. 長さは本文を読む前に確かめる。
  const header = request.headers.get("Content-Length");
  if (header === null) return reply(411, { error: "length_required" });
  const length = /^\d+$/.test(header.trim()) ? Number(header.trim()) : Number.NaN;
  if (!Number.isSafeInteger(length) || length === 0 || !request.body) {
    return reply(400, { error: "invalid_length" });
  }
  if (length > MAX_URL_UPLOAD_BYTES) {
    return reply(413, { error: "too_large", max_bytes: MAX_URL_UPLOAD_BYTES });
  }

  // 5. 「存在しなければ」の条件付き put。2 回目以降(上書き)は 409。
  const key = uploadKeys(id).data;
  // put の例外(R2 の障害、本文が途中で切れた、など)は外側で 503 にする。R2 の put は原子的なので何も書かれず、
  // 同じ URL で再送できる。ここで delete はしない(同時に通った別の PUT の本文を消してしまうため)。
  const stored = await bucket.put(key, request.body, {
    onlyIf: new Headers({ "If-None-Match": "*" }),
  });
  if (stored === null) return reply(409, { error: "already_uploaded" });

  // 6. 実際に保存した大きさが申告と違えば、消して 400。
  if (stored.size !== length) {
    await bucket.delete(key).catch(() => undefined);
    return reply(400, { error: "size_mismatch" });
  }
  return reply(201, { upload_id: id, size: stored.size });
}
