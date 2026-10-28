import type { BacklogClient } from "../../backlog/client";

/** ダウンロード系ツールの上限(logvalet と同じ 20 MiB)。 */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** バイト列を base64 にする(大きな配列でも呼び出しスタックを溢れさせないよう分割する)。 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
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
