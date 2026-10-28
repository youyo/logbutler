# ADR 0005: 冪等キャッシュを KV に置く

- 状態: 採用(M04)
- 日付: 2026-10-28(KV を使うこと・TTL・キーにユーザー ID を含めることはロードマップ「決定済み事項」)

## 背景

MCP の stream 再開が廃止され、クライアントが接続断のあとに同じ create 系ツールの呼び出しを再送する可能性が上がった。
logvalet は WriteNonIdempotent の 4 ツール(`issue_create` `issue_comment_add` `issue_attachment_upload` `document_create`)を、
プロセス内メモリの `IdempotencyCache`(TTL 5 分)で守っていた。Workers はリクエストごとに別 isolate になりうるため、メモリには置けない。

logvalet のキャッシュには次の問題があった。

- キーに利用者が入らないので、別ユーザーの同一引数の呼び出しが衝突しうる。
- `params._meta.idempotency_key` を読む実装はあるが、本番のハンドラは `_meta` を渡しておらず、効いていなかった。
- エラーもキャッシュするので、一時障害のあとに 5 分間リトライできない。

## 決定

- 対象は WriteNonIdempotent の 4 ツールだけ(logvalet と同じ)。`registerTools`(`src/mcp/registry.ts`)が、引数の検証が済んだあとにハンドラを包む。実装は `src/mcp/idempotency.ts`。
- **保存先は、OAuth と同じ KV namespace(`OAUTH_KV`)の `idem:` 接頭辞**。別の binding は作らない。理由: デプロイ手順(namespace の作成と id の差し替え)を増やさない。`workers-oauth-provider` が使う接頭辞は `client:` `grant:` `token:` だけで、`list` も接頭辞つきなので衝突しない。TTL つきのキーなので OAuth の保存物と運用上の区別も要らない。分けたくなったら `Env` に binding を足し、`api-handler.ts` の 1 行を差し替えるだけでよい。
- キー: `idem:<backlogUserId>:<toolName>:<explicit|hash>:<値>`。ユーザー ID は grant の props(`backlogUserId`)。
  - 明示キー(`explicit`)は、`params._meta.idempotency_key` → 引数の `idempotency_key` の順。空文字・文字列でない値は無いものとして扱う。UTF-8 で 200 バイトを超えると `argument_error`(`idem:<ユーザーID>:<ツール名>:explicit:` を足しても KV のキー上限 512 バイトに収めるため。文字数ではなくバイト長で数える)。
  - 明示キーがなければ `hash`: 検証済みの引数を canonical JSON(キーをソート)にした SHA-256(16 進)。
  - 明示キーが同じなら、引数が違っても同じ呼び出しとみなす(logvalet と同じ)。
- `idempotency_key` は **inputSchema に宣言しない**(logvalet の baseline と一致させるため)。SDK には公開用のスキーマだけを渡し、検証は自前で行う(`advertiseOnly`)ので、未知の引数としては落ちない。明示キーは zod の検証前の生の引数と `ctx.mcpReq._meta` から取る。
- 保存するのは**成功した結果の JSON 文字列だけ**。TTL 300 秒(KV の最小 60 秒以上)。エラーは保存しない(logvalet との意図した差分。保存すると一時障害のあと 5 分間リトライできない)。
- 重複だった場合も初回と同じ結果をそのまま返す。応答に重複の印は付けない(logvalet と同じ)。
- 保存する値は、ツールが返した結果の JSON だけ。Backlog のトークン・クライアント情報は含めない。結果には Backlog が返した課題・コメントなどの内容が入るので、他の利用者のキーからは読めないようキーにユーザー ID を含める。
- KV の読み書きの失敗はツール呼び出しを止めない。読めなければ実行し、書けなくても結果は返す(例外名だけログに残す)。冪等キャッシュは重複実行の防止策であって、書き込み自体の前提条件ではない。

## 限界(受け入れる)

KV は結果整合で、排他制御(ロック)もない。したがって:

- **ほぼ同時の 2 回の呼び出しは、両方実行されうる**。1 回目の保存が 2 回目の読み取りに間に合わない。logvalet はプロセス内で「実行中なら完了を待つ」ことで防いでいたが、同じことには Durable Objects が要る。Durable Objects は使わない方針(ADR 0001・ロードマップ)なので受け入れる。これは再送(時間をおいた同じ呼び出し)への対策であり、同時実行の排他ではない。
- 別のロケーションからの読み取りは、保存から最大 60 秒ほど古い値を見ることがある(KV の結果整合)。再送が直後に別のロケーションに届くと重複しうる。
- 明示キーが引数と無関係に同一視されるため、クライアントが別の依頼に同じキーを使い回すと、2 回目は 1 回目の結果が返る。

## 却下した案

- Durable Objects でキーごとに直列化する: 排他は取れるが、DO なしの方針に反する。
- Cache API(`caches.default`): データセンター単位で、保存の保証も弱い。
- 別の KV namespace: 運用手順が増える割に得るものが少ない(上記)。
- エラーもキャッシュする(logvalet と同じ): 一時障害のあとに再送できなくなる。
- 重複に印(`duplicate: true` など)を付ける: logvalet と応答の形が変わる。
