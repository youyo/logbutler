import type { BacklogClient } from "../../backlog/client";

/** ダウンロード系ツールの上限(logvalet と同じ 20 MiB)。 */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** 1 回に base64 化する長さ。3 の倍数(パディングは最後の塊にだけ出る)で、バイナリ文字列は 96 KiB に収まる。 */
const BASE64_CHUNK = 3 * 32 * 1024;

/**
 * バイト列を base64 にする。3 バイトの倍数ずつ変換して連結するので、巨大なバイナリ文字列を作らず、
 * 呼び出しスタックも溢れさせない(ピークのメモリは入力 + 出力 + 1 塊分)。
 */
export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    const chunk = bytes.subarray(i, i + BASE64_CHUNK);
    let binary = "";
    // fromCharCode(...chunk) は引数の個数に上限があるため、さらに小さく刻む。
    for (let j = 0; j < chunk.length; j += 0x2000) {
      binary += String.fromCharCode(...chunk.subarray(j, j + 0x2000));
    }
    parts.push(btoa(binary));
  }
  return parts.join("");
}

/**
 * ダウンロードして logvalet と同じ形で返す。加工した出力なので snake_case(ADR 0004)。
 * 上限を超えたら DownloadTooLargeError(エンベロープ)になる。
 */
export async function downloadResult(client: BacklogClient, path: string) {
  const file = await client.download(path, { maxBytes: MAX_DOWNLOAD_BYTES });
  return {
    content_base64: toBase64(file.data),
    filename: file.filename,
    content_type: file.contentType,
    size_bytes: file.data.byteLength,
  };
}
