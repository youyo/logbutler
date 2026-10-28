/**
 * MCP の POST 本文の読み取り。
 *
 * agents の `createMcpHandler`（stateless）は 2025 年版プロトコルかどうかを `isLegacyRequest` で判定するが、
 * そこへ `maxRequestBodySize` を渡さない。そのため本文が 4 MiB（SDK の既定）を超えると、設定を変えても
 * 「プロトコルバージョンが読めない」400 になる。4 MiB のファイルを base64 にして JSON に入れると約 5.6 MB なので、
 * issue_attachment_upload が上限ちょうどのファイルを受け取れない。
 *
 * ここで自前で本文を読み（上限は 8 MiB）、パース済みの本文を `parsedBody` として渡す。
 * `parsedBody` を渡すと SDK は本文を読み直さず、サイズ上限も適用しない。
 */
import type { StatelessMcpHandler } from "agents/mcp/server";

/** base64 + JSON のオーバーヘッドを見込んだ、MCP の POST 本文の上限。 */
export const MAX_MCP_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

const tooLarge = () =>
  new Response(JSON.stringify({ error: "payload_too_large" }), {
    status: 413,
    headers: { "Content-Type": "application/json" },
  });

export async function callMcpHandler(
  handler: StatelessMcpHandler,
  request: Request,
): Promise<Response> {
  if (request.method !== "POST" || request.body === null) return handler.fetch(request);

  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_MCP_REQUEST_BODY_BYTES) return tooLarge();

  const bytes = await readCapped(request.body, MAX_MCP_REQUEST_BODY_BYTES);
  if (bytes === undefined) return tooLarge();

  const text = new TextDecoder().decode(bytes);
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(text);
  } catch {
    // 壊れた JSON は SDK に判断させる（本文は読み終えているので作り直す）。
    return handler.fetch(new Request(request, { body: text }));
  }
  return handler.fetch(request, { parsedBody });
}

/** 上限を超えたら読むのをやめて undefined。 */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  max: number,
): Promise<Uint8Array | undefined> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
