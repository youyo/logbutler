/**
 * 応答サイズの上限(安全網。ADR 0007)。ツール引数 `max_response_tokens`(整数、0 で無効)。
 * 切り詰めず、超えたら response_too_large のエラーにする。
 */
import { z } from "zod";
import { ArgumentError, ResponseTooLargeError } from "../errors";

/** `max_response_tokens` を省略したときの上限(推定トークン数)。 */
export const DEFAULT_MAX_RESPONSE_TOKENS = 50000;

/**
 * 応答 JSON 文字列のトークン数の近似。ASCII は 4 文字 1 トークン(切り上げ)、ASCII 以外(日本語など)は
 * 1 文字 1 トークンとして数える。実際のトークナイザの値ではなく、桁を外さないための目安。
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}

export const MAX_RESPONSE_TOKENS_DESCRIPTION = `Safety limit on the estimated response size in tokens (default: ${DEFAULT_MAX_RESPONSE_TOKENS}, 0 disables). If exceeded, the call fails with response_too_large instead of returning a truncated result`;

/** 読み取りツールの入力スキーマに足す引数。 */
export const maxResponseTokensShape = {
  max_response_tokens: z
    .number()
    .refine((n) => Number.isInteger(n), "must be an integer")
    .describe(MAX_RESPONSE_TOKENS_DESCRIPTION)
    .optional(),
};

/** 引数 `max_response_tokens` から実際の上限を決める。未指定は既定値、0 は無効、負の値は ArgumentError。 */
export function resolveResponseLimit(arg: number | undefined): number {
  const max = arg ?? DEFAULT_MAX_RESPONSE_TOKENS;
  if (max < 0) throw new ArgumentError(`max_response_tokens must be 0 or greater, got ${max}`);
  return max;
}

/** 応答 JSON が上限(0 なら無制限)を超えていたら ResponseTooLargeError。 */
export function assertWithinResponseLimit(text: string, max: number): void {
  if (max === 0) return;
  const estimated = estimateTokens(text);
  if (estimated > max) throw new ResponseTooLargeError(estimated, max);
}
