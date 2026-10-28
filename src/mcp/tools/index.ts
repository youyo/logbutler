import type { ToolDefinition } from "../registry";
import { activityList } from "./activity";
import { documentGet, documentList, documentTree } from "./document";
import {
  issueAttachmentDownload,
  issueAttachmentList,
  issueCommentList,
  issueGet,
  issueList,
  issueRelatedList,
} from "./issue";
import { metaCategories, metaCustomField, metaIssueTypes, metaStatuses, metaVersion } from "./meta";
import { projectGet, projectList } from "./project";
import { sharedFileDownload, sharedFileList } from "./shared-file";
import { spaceDiskUsage, spaceInfo } from "./space";
import { teamGet, teamList, teamProject } from "./team";
import { userGet, userList } from "./user";
import { userMe } from "./user-me";
import { watchingCount, watchingGet, watchingList } from "./watching";
import {
  wikiAttachmentList,
  wikiCount,
  wikiGet,
  wikiHistory,
  wikiList,
  wikiSharedfileList,
  wikiStars,
  wikiTags,
} from "./wiki";

/** 公開するツールの一覧。M03 の読み取りツール(単純系)。M04 以降のツールはここに足す。 */
export const ALL_TOOLS: readonly ToolDefinition[] = [
  metaStatuses,
  metaIssueTypes,
  metaCategories,
  metaVersion,
  metaCustomField,
  projectGet,
  projectList,
  spaceInfo,
  spaceDiskUsage,
  teamList,
  teamGet,
  teamProject,
  userMe,
  userGet,
  userList,
  watchingList,
  watchingGet,
  watchingCount,
  wikiList,
  wikiGet,
  wikiCount,
  wikiTags,
  wikiHistory,
  wikiStars,
  wikiAttachmentList,
  wikiSharedfileList,
  sharedFileList,
  sharedFileDownload,
  documentGet,
  documentList,
  documentTree,
  activityList,
  issueGet,
  issueList,
  issueCommentList,
  issueAttachmentList,
  issueAttachmentDownload,
  issueRelatedList,
];
