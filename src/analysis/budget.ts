/**
 * 分析系ツールの API 呼び出しの予算(ADR 0006)。ツールごとに最悪ケースの式から決め、
 * `defineTool` の `maxApiCalls` に明示する。式の根拠は ADR 0006 の表。
 *
 * - 1 ページ = 100 件、ページ数の上限は `DEFAULT_MAX_PAGES`(10)。直列に取る。
 * - GetProject は同じクライアントの中でキャッシュされる(`resolveProjectId`)。
 */
import { DEFAULT_MAX_PAGES } from "../backlog/paging";
import { PROJECT_ISSUE_CALLS } from "./issues";

/** `project_keys`(CSV)で受け付けるプロジェクト数の上限。logvalet は無制限。 */
export const MAX_PROJECT_KEYS = 5;
/** blocked_by_keyword のためのコメント確認(課題 1 件につき 1 回)の上限。 */
export const COMMENT_LOOKUP_BUDGET = 50;
/** timeline の `max_activity_pages` の上限。 */
export const MAX_ACTIVITY_PAGES = DEFAULT_MAX_PAGES;

/** `search` の Wiki 検索の対象プロジェクト数の上限(プロジェクトごとに 1 回呼ぶため)。logvalet は全プロジェクト。 */
export const MAX_SEARCH_WIKI_PROJECTS = 10;
/** `digest_unified` の入力と展開後の上限。logvalet は無制限(最悪 2,000 回超)。 */
export const UNIFIED_MAX_TEAMS = 3;
/** `user_ids` とチーム展開後のユーザー数の合計の上限。 */
export const UNIFIED_MAX_USERS = 10;
export const UNIFIED_MAX_ISSUE_KEYS = 20;
/** `digest_unified` のアクティビティを 1 ソース(ユーザー / プロジェクト / スペース)ごとに辿るページ数の上限(= 500 件)。 */
export const UNIFIED_ACTIVITY_PAGES = 5;

/** 規約(conventions)の読み込み: 課題種別一覧 1 + 規約課題のページング(最大 10)。 */
const CONVENTIONS_CALLS = 1 + DEFAULT_MAX_PAGES;

export const API_BUDGET = {
  /** P × (GetProject 1 + 課題 10 ページ) */
  issueStale: MAX_PROJECT_KEYS * PROJECT_ISSUE_CALLS,
  /** P × (1 + 10) + コメント確認 COMMENT_LOOKUP_BUDGET */
  projectBlockers: MAX_PROJECT_KEYS * PROJECT_ISSUE_CALLS + COMMENT_LOOKUP_BUDGET,
  /** 1 + 10 */
  userWorkload: PROJECT_ISSUE_CALLS,
  /** (1 + 10) + 規約 (1 + 10) + コメント確認 */
  projectHealth: PROJECT_ISSUE_CALLS + CONVENTIONS_CALLS + COMMENT_LOOKUP_BUDGET,
  /** GetIssue 1 + コメント 10 ページ + ステータス 1 + 関連課題 1 */
  issueContext: 1 + DEFAULT_MAX_PAGES + 1 + 1,
  /** GetIssue 1 + (1 + 課題 10 ページ) + コメント 10 ページ + 関連課題 1 */
  issueTriageMaterials: 1 + PROJECT_ISSUE_CALLS + DEFAULT_MAX_PAGES + 1,
  /** GetMyself 1 + overdue 10 + upcoming 10 + watching 10 */
  myTasks: 1 + 3 * DEFAULT_MAX_PAGES,
  /** GetProject 1 + 課題 10 ページ */
  digestPeriodic: PROJECT_ISSUE_CALLS,
  /** GetIssue 1 + コメント 10 ページ + アクティビティ MAX_ACTIVITY_PAGES ページ */
  issueTimeline: 1 + DEFAULT_MAX_PAGES + MAX_ACTIVITY_PAGES,
  /** (user: GetMyself 1) + アクティビティ 10 ページ */
  activityStats: 1 + DEFAULT_MAX_PAGES,

  // --- M05B ---
  /** GetSpace 1 + GetSpaceDiskUsage 1 */
  spaceDigest: 2,
  /** GetDocument 1 + ListProjects 1 + ListDocumentAttachments 1 */
  documentDigest: 3,
  /** (project_keys: GetProject P + 検索 1)。キーなしは 検索 1 + ListProjects 1 = 2 で、前者が大きい。 */
  documentSearch: MAX_PROJECT_KEYS + 1,
  /**
   * キーあり: GetProject P + 課題 1 + ドキュメント 1 + Wiki P(= プロジェクト数)。
   * キーなし: ListProjects 1 + 課題 1 + ドキュメント 1 + Wiki MAX_SEARCH_WIKI_PROJECTS。
   */
  search: Math.max(MAX_PROJECT_KEYS + 2 + MAX_PROJECT_KEYS, 1 + 2 + MAX_SEARCH_WIKI_PROJECTS),
  /** アクティビティ 1 回(limit ≤ 100 の 1 ページ) */
  activityDigest: 1,
  /** (GetMyself 1) + アクティビティ 10 ページ */
  userActivity: 1 + DEFAULT_MAX_PAGES,
  /**
   * チーム T + プロジェクト P + ユーザー U(GetUser)+ max(課題 10 ページ, 課題キー K)
   * + アクティビティのソース max(U, P) × UNIFIED_ACTIVITY_PAGES
   */
  digestUnified:
    UNIFIED_MAX_TEAMS +
    MAX_PROJECT_KEYS +
    UNIFIED_MAX_USERS +
    Math.max(DEFAULT_MAX_PAGES, UNIFIED_MAX_ISSUE_KEYS) +
    Math.max(UNIFIED_MAX_USERS, MAX_PROJECT_KEYS) * UNIFIED_ACTIVITY_PAGES,
} as const;
