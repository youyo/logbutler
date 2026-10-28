import type { ToolDefinition } from "../registry";
import { activityList } from "./activity";
import {
  activityStats,
  digestDaily,
  digestWeekly,
  issueContext,
  issueStale,
  issueTimeline,
  issueTriageMaterials,
  myTasks,
  projectBlockers,
  projectHealth,
  userWorkload,
} from "./analysis";
import {
  activityDigest,
  digestUnified,
  documentDigest,
  documentSearch,
  search,
  spaceDigest,
  userActivity,
} from "./digest";
import { documentCreate, documentGet, documentList, documentTree } from "./document";
import {
  issueAttachmentDownload,
  issueAttachmentList,
  issueCommentList,
  issueGet,
  issueList,
  issueRelatedList,
} from "./issue";
import {
  issueAttachmentDelete,
  issueAttachmentUpload,
  issueCommentAdd,
  issueCommentUpdate,
  issueCreate,
  issueRelatedAdd,
  issueRelatedDelete,
  issueUpdate,
} from "./issue-write";
import { metaCategories, metaCustomField, metaIssueTypes, metaStatuses, metaVersion } from "./meta";
import { projectConventions, projectGet, projectList } from "./project";
import { sharedFileDownload, sharedFileList } from "./shared-file";
import { spaceDiskUsage, spaceInfo } from "./space";
import { starAdd } from "./star";
import { teamGet, teamList, teamProject } from "./team";
import { userGet, userList } from "./user";
import { userMe } from "./user-me";
import {
  watchingAdd,
  watchingCount,
  watchingDelete,
  watchingGet,
  watchingList,
  watchingMarkAsRead,
  watchingUpdate,
} from "./watching";
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

/** 公開するツールの一覧。M03 の読み取りツール(単純系)、M04 の書き込みツール、M05A の分析ツール。M05B の digest・検索の 7 個。 */
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
  // M04: 書き込み・破壊的ツール 14 個と project_conventions
  issueCreate,
  issueCommentAdd,
  issueAttachmentUpload,
  documentCreate,
  issueUpdate,
  issueCommentUpdate,
  issueRelatedAdd,
  starAdd,
  watchingAdd,
  watchingUpdate,
  watchingMarkAsRead,
  issueRelatedDelete,
  issueAttachmentDelete,
  watchingDelete,
  projectConventions,
  // M05A: 分析系の加工ツール 11 個
  issueStale,
  projectBlockers,
  userWorkload,
  projectHealth,
  issueContext,
  issueTriageMaterials,
  myTasks,
  digestDaily,
  digestWeekly,
  issueTimeline,
  activityStats,
  // M05B: digest 系 6 個と user_activity
  spaceDigest,
  documentDigest,
  documentSearch,
  search,
  activityDigest,
  userActivity,
  digestUnified,
];
