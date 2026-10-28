// `mise run verify:oauth -- https://<domain>/mcp` の入口(Node 24 の型ストリップで直接実行する)。
// 実環境の OAuth 確認の流れは core.ts、ループバック受信は loopback.ts。ここは引数・ブラウザ起動・状態ファイルだけ。
import { spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "./args.ts";
import { formatReport, runVerification, type SavedState, type VerifyIo } from "./core.ts";
import { startLoopbackReceiver } from "./loopback.ts";

function openInBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  // 開けなくても URL は表示済み。手でブラウザに貼ってもらう。
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () =>
    console.log("(ブラウザを自動で開けませんでした。上の URL を手で開いてください)"),
  );
  child.unref();
}

async function main(): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    return 2;
  }

  const io: VerifyIo = {
    fetch: (input, init) => fetch(input, { redirect: "manual", ...init }),
    log: (line) => console.log(line),
    startReceiver: () => startLoopbackReceiver(),
    openBrowser: openInBrowser,
    loadState: async () => {
      try {
        return JSON.parse(await readFile(args.stateFile, "utf8")) as SavedState;
      } catch {
        return undefined;
      }
    },
    saveState: async (state) => {
      // リフレッシュトークンを含む。自分だけが読める権限で書く(.gitignore 済みの名前が既定)。
      await writeFile(args.stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await chmod(args.stateFile, 0o600);
    },
  };

  console.log(`対象: ${args.mcpUrl}${args.refreshOnly ? "(--refresh-only)" : ""}`);
  const report = await runVerification({ mcpUrl: args.mcpUrl, refreshOnly: args.refreshOnly }, io);
  console.log("");
  for (const line of formatReport(report)) console.log(line);
  if (report.steps.some((s) => s.name === "token" && s.ok) || (args.refreshOnly && report.ok)) {
    console.log(
      `\n状態を ${args.stateFile} に保存しました(リフレッシュトークンを含む。コミットしない・共有しない)。`,
    );
  }
  return report.ok ? 0 : 1;
}

process.exitCode = await main();
