import { z } from "zod";
import { optInt, optStr, positiveOrUndefined, reqInt, reqStr, seg } from "../args";
import { defineTool } from "../registry";
import { downloadResult } from "./download";

export const sharedFileList = defineTool({
  name: "logbutler_shared_file_list",
  title: "共有ファイル一覧取得",
  description: "List shared files in a project",
  category: "ReadOnly",
  toolset: "shared_file",
  inputSchema: z.object({
    project_key: reqStr("Project key"),
    path: optStr("Directory path within the project (default: root)"),
    count: optInt("Max number of files"),
    offset: optInt("Offset for pagination"),
  }),
  handler: ({ project_key, path, count, offset }, { client }) => {
    // logvalet は path を未エスケープでパスに埋め込んでいた。logbutler はセグメントごとにエスケープする。
    const dir = (path ?? "").replace(/^\/+/, "");
    const encoded = dir === "" ? "" : dir.split("/").map(seg).join("/");
    return client.request("GET", `/projects/${seg(project_key)}/files/metadata/${encoded}`, {
      query: { count: positiveOrUndefined(count), offset: positiveOrUndefined(offset) },
    });
  },
});

export const sharedFileDownload = defineTool({
  name: "logbutler_shared_file_download",
  responseLimit: false, // ファイルサイズの上限は別にある(MAX_DOWNLOAD_BYTES)
  title: "共有ファイルダウンロード",
  description: "Download a shared file (max 20MB, returned as base64)",
  category: "ReadOnly",
  toolset: "shared_file",
  inputSchema: z.object({
    project_key: reqStr("Project key"),
    file_id: reqInt("Shared file ID"),
  }),
  handler: async ({ project_key, file_id }, { client }) =>
    downloadResult(client, `/projects/${seg(project_key)}/files/${seg(file_id)}`),
});
