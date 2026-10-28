import { describe, expect, it } from "vitest";
import { grantRefFromAccessToken } from "../../src/auth/backlog-stale";

describe("grantRefFromAccessToken", () => {
  it("{userId}:{grantId}:{secret} から userId と grantId を返す", () => {
    expect(grantRefFromAccessToken("42:grant-1:secret")).toEqual({
      userId: "42",
      grantId: "grant-1",
    });
  });

  it.each([
    ["undefined", undefined],
    ["空文字", ""],
    ["`:` が 0 個", "plain-token"],
    ["`:` が 1 個", "42:grant-1"],
    ["4 要素(`:` が 3 個)", "42:grant-1:secret:extra"],
    ["空の userId", ":grant-1:secret"],
    ["空の grantId", "42::secret"],
    ["空の userId と grantId", "::secret"],
  ])("印を置かない: %s", (_name, token) => {
    expect(grantRefFromAccessToken(token)).toBeUndefined();
  });
});
