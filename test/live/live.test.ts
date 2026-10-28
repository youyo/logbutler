/**
 * 実環境の E2E(`mise run test:live`)。デプロイ済みの Worker と実 Backlog に通信し、LOGBUTLER_LIVE_PROJECT_KEY の
 * プロジェクトにだけ書き込む。`mise run test` には含めない。suite の順序に依存する(課題を作ってから読み戻す)。
 */
import { analysisSuite } from "./suites/analysis";
import { issueSuite } from "./suites/issue";
import { projectSettingsSuite } from "./suites/project-settings";
import { protocolSuite } from "./suites/protocol";
import { readBasicSuite } from "./suites/read-basic";
import { setupSuite } from "./suites/setup";
import { watchDocSuite } from "./suites/watch-doc";

setupSuite();
readBasicSuite();
issueSuite();
projectSettingsSuite();
watchDocSuite();
analysisSuite();
protocolSuite();
