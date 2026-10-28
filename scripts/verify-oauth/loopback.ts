// ループバック(127.0.0.1)でブラウザのリダイレクトを受ける。Node 専用(node:http)。
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { CallbackReceiver } from "./core.ts";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const DONE_PAGE =
  '<!doctype html><meta charset="utf-8"><title>verify:oauth</title>' +
  "<p>verify:oauth: 認可の応答を受け取りました。このタブは閉じてかまいません。ターミナルに戻ってください。</p>";

/** 空きポートで待ち受け、`/callback` に届いたリダイレクト先の URL(クエリつき)を wait() で返す。 */
export async function startLoopbackReceiver(
  opts: { timeoutMs?: number } = {},
): Promise<CallbackReceiver> {
  let resolveCallback!: (url: string) => void;
  let rejectCallback!: (e: Error) => void;
  const received = new Promise<string>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  received.catch(() => {}); // wait() が呼ばれる前の失敗で unhandled rejection にしない

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      .end(DONE_PAGE);
    resolveCallback(`http://127.0.0.1:${(server.address() as AddressInfo).port}${req.url}`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(
    () =>
      rejectCallback(
        new Error(`ブラウザの応答待ちがタイムアウトしました(${Math.round(timeoutMs / 1000)} 秒)`),
      ),
    timeoutMs,
  );
  const port = (server.address() as AddressInfo).port;
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    wait: () => received,
    close() {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
    },
  };
}
