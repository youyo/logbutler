/** digest 系ツールの入力の読み取りと、URL の組み立て。 */
import { ArgumentError } from "../errors";

/** `detail`(snippet / meta / full など)。未指定は既定値。それ以外は argument_error(logvalet は黙って meta 扱いだった)。 */
export function parseDetail<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined || value === "") return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new ArgumentError(`detail must be one of: ${allowed.join(", ")}, got "${value}"`);
}

/** 同じ値を 1 つにまとめ、上限を超えたら argument_error。 */
export function capList<T>(name: string, items: readonly T[], max: number): T[] {
  const unique = [...new Set(items)];
  if (unique.length > max) {
    throw new ArgumentError(`${name} accepts at most ${max} values per call, got ${unique.length}`);
  }
  return unique;
}

/** URL のパスの 1 セグメント(logvalet の `url.PathEscape` 相当。`/` や空白を含んでも URL が壊れない)。 */
export const pathPart = (value: string | number): string => encodeURIComponent(String(value));
