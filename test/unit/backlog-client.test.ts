import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BacklogApiError,
  BacklogUnauthorizedError,
  createBacklogClient,
} from "../../src/backlog/client";
import { jsonResponse, mockOutboundFetch } from "../helpers/mock-fetch";

const MYSELF = "GET https://example.backlog.com/api/v2/users/myself";
const make = () => createBacklogClient({ spaceHost: "example.backlog.com", accessToken: "at-1" });

afterEach(() => vi.restoreAllMocks());

describe("BacklogClient.getMyself", () => {
  it("Bearer 付きで /api/v2/users/myself を呼び、ユーザーを返す", async () => {
    const m = mockOutboundFetch({
      [MYSELF]: () =>
        jsonResponse({
          id: 42,
          userId: "alice",
          name: "Alice",
          mailAddress: "a@example.com",
          roleType: 2,
        }),
    });
    const user = await make().getMyself();
    expect(user).toEqual({
      id: 42,
      userId: "alice",
      name: "Alice",
      mailAddress: "a@example.com",
      roleType: 2,
    });
    expect(m.calls[0]?.headers.get("authorization")).toBe("Bearer at-1");
  });

  it("401 は BacklogUnauthorizedError(クライアントにリフレッシュさせる合図)", async () => {
    mockOutboundFetch({ [MYSELF]: () => jsonResponse({ errors: [{ message: "x" }] }, 401) });
    await expect(make().getMyself()).rejects.toBeInstanceOf(BacklogUnauthorizedError);
  });

  it("その他のエラーは status を持つ BacklogApiError(トークンを含めない)", async () => {
    mockOutboundFetch({ [MYSELF]: () => jsonResponse({}, 503) });
    const err = await make()
      .getMyself()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BacklogApiError);
    expect((err as BacklogApiError).status).toBe(503);
    expect((err as BacklogApiError).message).not.toContain("at-1");
  });
});
