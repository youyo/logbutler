/**
 * 添付アップロードの URL 経路の完了処理(ADR 0018)。`logbutler_issue_attachment_upload` に upload_id が渡されたとき。
 *
 * 状態は `claim/<id>`(R2)に置き、**削除せず、すべての遷移を条件付き put で行う**(作成は「存在しなければ」、
 * それ以外は etagMatches。R2 の delete には条件が付けられないため)。遷移の前提には、自分の put が返した etag を使う
 * (読み直した etag では、引き継がれたことを検出できない)。
 *
 *   なし ──作成──▶ claimed ──POST 成功──▶ attached ──PATCH 成功──▶ done
 *                    │  ▲                     │(PATCH 失敗は attached のまま。再試行は PATCH だけ)
 *          POST 失敗 ▼  │ 引き継ぎ(released、または lease 切れの claimed)
 *                  released
 *
 * claim の本文には試行ごとの乱数(nonce)を入れる。R2 の etag は内容のハッシュなので、時刻が同じだと
 * claimed → released → claimed で etag が元に戻り、古い処理の etagMatches が通ってしまうため。
 */
import { BacklogApiError, type BacklogClient, BacklogUnauthorizedError } from "../backlog/client";
import { ArgumentError, LogbutlerError } from "../errors";
import { seg } from "../mcp/args";
import {
  CLAIM_LEASE_MS,
  COMPLETE_WINDOW_MS,
  isTicketLive,
  isUploadId,
  newNonce,
  readUploadTicket,
  uploadKeys,
} from "./store";

/** ツールに渡す R2 と利用者(ToolContext.uploads)。binding が無い Worker では渡さない。 */
export interface UploadDeps {
  bucket: R2Bucket;
  /** Backlog のユーザー ID(grant の props)。ticket・claim の所有者と照合する。 */
  userId: number;
  /** PUBLIC_BASE_URL(upload_url の組み立て用)。 */
  baseUrl: string;
}

type ClaimState = "claimed" | "released" | "attached" | "done";

/** `claim/<id>` の本文(snake_case は引数と同じ名前、ほかは仕様のとおり)。 */
interface Claim {
  uid: number;
  issue_key: string;
  file_name: string;
  state: ClaimState;
  attachmentId?: number;
  claimedAt: number;
  nonce: string;
}

export interface AttachRequest {
  uploadId: string;
  issueKey: string;
  /** 利用者が渡した file_name(claim との照合用)。 */
  fileName: string;
  /** Backlog に送るファイル名(ベース名)。 */
  safeName: string;
}

const PREPARE_HINT = "Call logbutler_issue_attachment_upload_prepare to get a new upload URL.";

/** 存在しない・期限切れ・他人のもの。どれも同じにして、存在を教えない。 */
function notFound(): LogbutlerError {
  return new LogbutlerError("not_found", `upload_id not found or expired. ${PREPARE_HINT}`, false);
}

function notUploadedYet(): LogbutlerError {
  return new LogbutlerError(
    "not_found",
    "No file has been uploaded for this upload_id yet. PUT the file to upload_url first (e.g. curl -sS --fail -T <path> '<upload_url>'), then retry with the same arguments.",
    true,
  );
}

function inProgress(): LogbutlerError {
  return new LogbutlerError(
    "generic_error",
    "This upload is in progress in another call. Retry with the same arguments in a few minutes.",
    true,
  );
}

function alreadyCompleted(): LogbutlerError {
  return new ArgumentError(
    `This upload_id has already been attached to the issue (completed). ${PREPARE_HINT}`,
  );
}

const asJson = (claim: Claim) => JSON.stringify(claim);

/** 読めない claim は「存在しない」と同じに扱う(壊れた本文で処理を進めない)。 */
function parseClaim(text: string): Claim | null {
  try {
    const c = JSON.parse(text) as Partial<Claim>;
    if (
      typeof c.uid !== "number" ||
      typeof c.issue_key !== "string" ||
      typeof c.file_name !== "string" ||
      typeof c.claimedAt !== "number" ||
      !["claimed", "released", "attached", "done"].includes(c.state as string)
    ) {
      return null;
    }
    return c as Claim;
  } catch {
    return null;
  }
}

/** 4xx の明確な拒否(401 と 429 を除く)。それ以外(通信失敗・5xx・429・想定外の例外)は「応答が不明」。 */
function isClientRejection(e: unknown): e is BacklogApiError {
  return (
    e instanceof BacklogApiError &&
    e.status >= 400 &&
    e.status < 500 &&
    e.status !== 401 &&
    e.status !== 429
  );
}

export async function attachUploadedFile(
  deps: UploadDeps,
  client: BacklogClient,
  nowMs: number,
  req: AttachRequest,
): Promise<unknown> {
  seg(req.issueKey); // パスにできない課題キーは、Backlog を呼ぶ前に argument_error
  if (!isUploadId(req.uploadId)) throw notFound();
  const { bucket } = deps;
  const keys = uploadKeys(req.uploadId);

  let etag: string;
  let claim: Claim;
  const existing = await bucket.get(keys.claim);
  if (existing) {
    const current = parseClaim(await existing.text());
    if (!current || current.uid !== deps.userId) throw notFound();
    if (current.issue_key !== req.issueKey || current.file_name !== req.fileName) {
      throw new ArgumentError(
        "issue_key and file_name must be the same as in the first call for this upload_id",
      );
    }
    if (current.state === "done") throw alreadyCompleted();
    if (current.state === "attached") {
      // POST は済んでいる。同じ attachmentId で PATCH だけを行う(lease も ticket の期限も見ない)。
      return linkToIssue(deps, client, req, current, existing.etag, true);
    }
    if (current.state === "claimed" && nowMs < current.claimedAt + CLAIM_LEASE_MS) {
      throw inProgress();
    }
    // released、または lease 切れの claimed を引き継ぐ。
    const next: Claim = { ...current, state: "claimed", claimedAt: nowMs, nonce: newNonce() };
    const taken = await bucket.put(keys.claim, asJson(next), {
      onlyIf: { etagMatches: existing.etag },
    });
    if (!taken) throw inProgress();
    etag = taken.etag;
    claim = next;
  } else {
    // 期限は claim が無いときだけ見る。
    // 1. ticket が無い・uid が違う → not_found
    // 2. data がある → 保存時刻(R2 の uploaded)から 15 分以内なら進む。過ぎていれば not_found
    // 3. data が無い → ticket(PUT の受付 60 秒)が期限内なら「未アップロード」、切れていれば not_found
    const ticket = await readUploadTicket(bucket, req.uploadId);
    if (!ticket || ticket.uid !== deps.userId) throw notFound();
    const stored = await bucket.head(keys.data);
    if (stored) {
      if (nowMs > stored.uploaded.getTime() + COMPLETE_WINDOW_MS) throw notFound();
    } else {
      throw isTicketLive(ticket, nowMs) ? notUploadedYet() : notFound();
    }
    const next: Claim = {
      uid: deps.userId,
      issue_key: req.issueKey,
      file_name: req.fileName,
      state: "claimed",
      claimedAt: nowMs,
      nonce: newNonce(),
    };
    const created = await bucket.put(keys.claim, asJson(next), {
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
    if (!created) throw inProgress();
    etag = created.etag;
    claim = next;
  }

  /** claimed → released(失敗しても lease 切れで引き継げるので、ここでは投げない)。 */
  const release = async () => {
    try {
      await bucket.put(keys.claim, asJson({ ...claim, state: "released", nonce: newNonce() }), {
        onlyIf: { etagMatches: etag },
      });
    } catch {
      // lease(2 分)が切れれば引き継げる。
    }
  };

  const data = await bucket.get(keys.data);
  if (!data) {
    await release();
    throw notUploadedYet();
  }

  let attachmentId: number;
  try {
    const form = new FormData();
    form.append("file", new Blob([await data.arrayBuffer()]), req.safeName);
    const uploaded = await client.request<{ id?: unknown }>("POST", "/space/attachment", {
      multipart: form,
    });
    if (typeof uploaded?.id !== "number") {
      throw new LogbutlerError("api_error", "Backlog returned no attachment ID.", true);
    }
    attachmentId = uploaded.id;
  } catch (e) {
    // 明確なエラー応答でも応答不明でも、POST からやり直せるよう released にする。
    await release();
    // 401 は元の例外のまま投げる(MCP の応答を HTTP 401 にして、クライアントにトークンを更新させるため)。
    if (e instanceof BacklogUnauthorizedError) throw e;
    const base = e instanceof LogbutlerError ? e : null;
    throw new LogbutlerError(
      base?.code ?? "api_error",
      `${base?.message ?? "Uploading the file to Backlog did not complete."} The upload_id is still valid; retry with the same arguments.`,
      true,
    );
  }

  const attached: Claim = { ...claim, state: "attached", attachmentId, nonce: newNonce() };
  const marked = await bucket.put(keys.claim, asJson(attached), {
    onlyIf: { etagMatches: etag },
  });
  // 不成立 = lease が切れて別の呼び出しに引き継がれた。PATCH は向こうに任せる(ここで進むと二重に添付しうる)。
  if (!marked) throw inProgress();
  return linkToIssue(deps, client, req, attached, marked.etag, false);
}

/** attached → PATCH → done → 後片付け(ticket → data の順)。 */
async function linkToIssue(
  deps: UploadDeps,
  client: BacklogClient,
  req: AttachRequest,
  claim: Claim,
  etag: string,
  isRetry: boolean,
): Promise<unknown> {
  const keys = uploadKeys(req.uploadId);
  let result: unknown;
  try {
    result = await client.request("PATCH", `/issues/${seg(req.issueKey)}`, {
      form: { attachmentId: [claim.attachmentId] },
    });
  } catch (e) {
    if (e instanceof BacklogUnauthorizedError) throw e;
    if (isClientRejection(e)) {
      if (isRetry) {
        throw new LogbutlerError(
          e.code,
          `Backlog rejected attaching the uploaded file to ${req.issueKey} (${e.message}). The file may already be attached to the issue; check with logbutler_issue_attachment_list before uploading again.`,
          false,
        );
      }
      // 初回の明確な拒否(例: issue_key の誤り)。claim は attached のまま残り、issue_key を直した再試行は
      // 「claim と違う」になるので、この upload_id はもう使えないことを伝える(コードと retryable は Backlog のまま)。
      throw new LogbutlerError(
        e.code,
        `${e.message} The file was not attached to ${req.issueKey}. This upload_id can no longer be used; start over from logbutler_issue_attachment_upload_prepare.`,
        e.retryable,
      );
    }
    const base = e instanceof LogbutlerError ? e.message : "Backlog did not respond.";
    throw new LogbutlerError(
      e instanceof LogbutlerError ? e.code : "api_error",
      `The file was uploaded to Backlog but attaching it to ${req.issueKey} did not complete (${base}). Retry with the same arguments; the file will not be uploaded again.`,
      true,
    );
  }

  // 成功は返す。ここから先の失敗は無視する(R2 のライフサイクルで回収する)。
  try {
    await deps.bucket.put(keys.claim, asJson({ ...claim, state: "done", nonce: newNonce() }), {
      onlyIf: { etagMatches: etag },
    });
  } catch {
    // 無視
  }
  // ticket を先に消す: 遅れて届いた PUT は ticket が無いので 404 になり、data が再作成されない。
  for (const key of [keys.ticket, keys.data]) {
    try {
      await deps.bucket.delete(key);
    } catch {
      // 無視
    }
  }
  return result;
}
