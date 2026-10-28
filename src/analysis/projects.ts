import type { BacklogClient } from "../backlog/client";
import { ArgumentError } from "../errors";
import { parseCsvStrings, seg } from "../mcp/args";
import { MAX_PROJECT_KEYS } from "./budget";

/** `project_keys`(CSV)。空は argument_error、重複は 1 つにまとめる、上限は MAX_PROJECT_KEYS。 */
export function parseProjectKeys(csv: string): string[] {
  const keys = [...new Set(parseCsvStrings(csv))];
  if (keys.length === 0) throw new ArgumentError("project_keys is required");
  if (keys.length > MAX_PROJECT_KEYS) {
    throw new ArgumentError(
      `project_keys accepts at most ${MAX_PROJECT_KEYS} projects per call, got ${keys.length}`,
    );
  }
  return keys;
}

/** 任意の `project_keys`(CSV)。未指定・空は `[]`。重複は 1 つにまとめ、上限は MAX_PROJECT_KEYS。 */
export function parseOptionalProjectKeys(csv: string | undefined): string[] {
  const keys = [...new Set(parseCsvStrings(csv))];
  if (keys.length > MAX_PROJECT_KEYS) {
    throw new ArgumentError(
      `project_keys accepts at most ${MAX_PROJECT_KEYS} projects per call, got ${keys.length}`,
    );
  }
  return keys;
}

export interface BacklogProject {
  id: number;
  projectKey: string;
  name: string;
}

/** GET /projects/{key}。ID だけでなくキーと名前も要るときに使う(`resolveProjectId` は ID だけを返す)。 */
export const fetchProject = (client: BacklogClient, key: string): Promise<BacklogProject> =>
  client.request<BacklogProject>("GET", `/projects/${seg(key)}`);
