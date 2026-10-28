// `mise run deploy:render` の入口(Node 24 の型ストリップで直接実行する)。
// upstream の wrangler.jsonc と LOGBUTLER_* 環境変数から、gitignore 済みのデプロイ用設定を生成する(ADR 0011)。
// ロジックは core.ts。ここは引数・ファイル入出力・終了コードだけ。
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { EXAMPLE_ENV, formatErrors, renderWranglerConfig } from "./core.ts";

const ROOT = resolve(import.meta.dirname, "../..");

interface Args {
  example: boolean;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { example: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--example") args.example = true;
    else if (a === "--out") {
      const v = argv[++i];
      if (!v) throw new Error("--out にはパスが要ります");
      args.out = v;
    } else throw new Error(`不明な引数: ${a}`);
  }
  return args;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    console.error("使い方: render-wrangler-config [--example] [--out <path>]");
    return 2;
  }

  const outName =
    args.out ?? (args.example ? "wrangler.deploy.example.jsonc" : "wrangler.deploy.jsonc");
  const out = isAbsolute(outName) ? outName : join(ROOT, outName);
  const env = args.example ? EXAMPLE_ENV : process.env;

  const base = await readFile(join(ROOT, "wrangler.jsonc"), "utf8");
  const result = renderWranglerConfig(base, env);
  if (!result.ok) {
    console.error("デプロイ用設定を作れません(値は表示しません):");
    for (const line of formatErrors(result.errors)) console.error(`  - ${line}`);
    return 1;
  }
  await writeFile(out, result.text);
  console.log(`生成しました: ${out}${args.example ? " (ダミー値。dry-run 専用)" : ""}`);
  return 0;
}

process.exitCode = await main();
