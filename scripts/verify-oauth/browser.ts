// ブラウザ起動のコマンド組み立て(純粋関数)。cmd.exe を経由せず、http(s) 以外は起動しない。
export function browserCommand(url: string, platform: NodeJS.Platform): [string, string[]] {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`http(s) 以外の URL は開けません: ${parsed.protocol}`);
  }
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}
