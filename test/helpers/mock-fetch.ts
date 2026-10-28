import { type MockInstance, vi } from "vitest";

export interface RecordedCall {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

type Handler = (call: RecordedCall) => Response | Promise<Response>;

/** 完全一致を優先し、なければ `*`(パスの 1 セグメント)を含むキーに一致するものを探す。 */
function findHandler(handlers: Record<string, Handler>, key: string): Handler | undefined {
  const exact = handlers[key];
  if (exact) return exact;
  for (const [pattern, handler] of Object.entries(handlers)) {
    if (!pattern.includes("*")) continue;
    const re = new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+")}$`,
    );
    if (re.test(key)) return handler;
  }
  return undefined;
}

/**
 * outbound fetch のモック。登録していない宛先への通信は例外にし、実 Backlog・実 Access へ
 * 通信が漏れないことをテストで保証する。キーは "METHOD https://host/path"(クエリは含めない。`*` はパスの 1 セグメントに一致)。
 */
export function mockOutboundFetch(handlers: Record<string, Handler>) {
  const calls: RecordedCall[] = [];
  const spy: MockInstance<typeof fetch> = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      const url = new URL(req.url);
      const call: RecordedCall = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: new TextDecoder().decode(await req.arrayBuffer()),
      };
      calls.push(call);
      const handler = findHandler(handlers, `${req.method} ${url.origin}${url.pathname}`);
      if (!handler) {
        throw new Error(`mockOutboundFetch: 想定外の outbound fetch ${req.method} ${req.url}`);
      }
      return handler(call);
    });
  return {
    calls,
    spy,
    callsTo(key: string) {
      return calls.filter(
        (c) => `${c.method} ${new URL(c.url).origin}${new URL(c.url).pathname}` === key,
      );
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
