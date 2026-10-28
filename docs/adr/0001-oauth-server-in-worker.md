# ADR 0001: Worker 自身を OAuth 認可サーバーにする

- 状態: 採用(M01)
- 日付: 2026-10-28

## 背景

Logbutler は Cloudflare MCP Server Portals 経由で使う Remote MCP サーバーで、利用者ごとの Backlog 権限で Backlog API を呼ぶ。
Backlog の認証は OAuth 2.0(認可コード)で、アクセストークンの寿命は約 1 時間、リフレッシュトークンで更新する。
Portal は DCR を持たない上流にも「手動クレデンシャル」で OAuth できるが、ユーザーのトークンが切れたときは再認証を求めるだけで、ユーザーのトークンを自動ではリフレッシュしない(調査メモ: `docs/research/2026-10-28-logvalet-and-nulab-mcp.md`)。

## 決定

Worker が MCP クライアント(Portal を含む)に対する OAuth 認可サーバーになる(`@cloudflare/workers-oauth-provider` の `OAuthProvider`)。
上流の IdP は Backlog OAuth 2.0 で、Worker は Backlog に対しては OAuth クライアントとして振る舞う。

- MCP クライアントには Worker が発行した不透明トークン(寿命 30 分)を渡す。Backlog のトークンはクライアントに渡さない。
- Backlog のアクセストークン・リフレッシュトークン・期限は、grant の `props` にだけ保存する(ライブラリが暗号化して KV に置く。平文の KV キーやログには出さない)。
- `tokenExchangeCallback` で、MCP トークンの更新時に Backlog のトークンも更新して `props` を差し替える(**いつ更新するか・MCP の寿命の式は ADR 0014 で変更**: Backlog は期限内の更新で同じトークンを返すため、保存期限を過ぎたとき・stale 印があるときだけ更新する)。Backlog 側で失効していれば `invalid_grant` を返して grant を失効させ、クライアントに再認可させる。一時障害なら `temporarily_unavailable`(503)で grant を残す。
- MCP トークンの寿命(30 分)を Backlog のアクセストークン(約 1 時間)より短くし、MCP の更新 1 回につき Backlog の更新が高々 1 回になるようにして、並列リフレッシュの競合を避ける。
- 利用者の保護(**ADR 0009 で置き換え**: Access 連携は削除した。利用者の制限は Logbutler の外側で行う。以下は M01 当時の決定): `/authorize` と `/callback` だけを Cloudflare Access(self-hosted app)で保護し、Worker 側でも `Cf-Access-Jwt-Assertion` を検証する(署名・iss・aud・期限)。`/mcp`・`/token`・`/register`・`/.well-known/*` は Portal がサーバー間で呼ぶので Access を通さず(Bypass)、Worker 発行トークンで守る。
- 同意画面(`/authorize`)で、クライアント名・リダイレクト先ホスト・Backlog のホストを表示し、承認後にだけ Backlog へリダイレクトする(confused deputy 対策。`beginConsent` / `approveConsent` / `beginUpstream` を使う)。

## 却下した案

### Portal の手動 OAuth で Backlog のトークンを Bearer としてそのまま流す(passthrough)

logvalet v0.40 の `remote-mcp-request-contract.md` の方式。Worker は OAuth サーバーを持たず、Portal が Backlog と直接 OAuth し、得たトークンを `Authorization: Bearer` で Worker に渡す。

却下の理由:

1. Portal はユーザーのトークンが切れると再認証を求めるだけで、自動でリフレッシュしない。Backlog のアクセストークンは約 1 時間で切れるため、約 1 時間ごとに利用者が再認証することになり、実用に耐えない。
2. Worker 側にリフレッシュトークンがないので、Worker から更新を肩代わりできない。
3. Backlog のトークンがクライアント(Portal)側に常駐する。Worker が発行する不透明トークンにすれば、Backlog のトークンの置き場を Worker の暗号化 KV に限定できる。

### Durable Objects / McpAgent で状態を持つ

認証状態は KV(grant・トークン)で足り、MCP 自体もステートレス(`createMcpHandler`)で済む。DO は使わない。

## 未検証の前提(実デプロイしていないため、実 API で確認が必要)

確認手順と結果の記入欄は [docs/manual-verification.md](../manual-verification.md)(項目 V01 〜 V04)。1・3・5 は 2026-10-29 の検証用 Worker の観測で確認済み(各項目の「確認済み」。設計変更は [ADR 0014](0014-backlog-refresh-only-after-expiry.md))。

1. **Backlog のリフレッシュトークンがローテーション(更新のたびに変わる)するか**。実装は両対応: トークン応答に `refresh_token` があれば `props` を差し替え、なければ元のものを維持する(`src/auth/backlog-oauth.ts`)。ローテーションする場合、同じ grant で更新が並列に走ると古いリフレッシュトークンが失効して `invalid_grant` になりうる。MCP の更新が Worker 側でトークン単位に直列化される保証は、ライブラリが旧トークンを次の使用まで有効に保つ挙動に頼っており、実機では未確認。
   - **確認済み(2026-10-29)**: 有効期限内の更新ではローテーションしない。04:29 の更新で `backlog_token` が `{"grant_type":"refresh_token","expires_in":1755,"refresh_token_rotated":false}`(応答に `refresh_token` がない、または同じ値)。失効後の更新でもローテーションしない(2026-10-29 05:00 実測)(実装は両対応のまま)。ローテーションしないので、並列更新の競合(上記)は期限内の更新では起きない。
   - **並列更新の実測(2026-10-29 07:01、V02)**: Backlog の失効後に、同じ MCP リフレッシュトークンで `/token` を 5 本同時に送ると、5 本とも 200 で、それぞれ Backlog を更新した(`backlog_token` 5 件、すべて `refresh_token_rotated:false`)。得た 5 つの MCP アクセストークンはどれも `/mcp` で使えた。ただし**新しい MCP リフレッシュトークンは 5 つのうち 1 つだけが有効**で、残る 4 つは次の使用で `invalid_grant` になった(ライブラリの grant の書き込みは後勝ちのため)。Backlog 側の競合は起きない。MCP 側では、同じ認証情報を複数のプロセスで共有して同時に更新するクライアントだけが再認可になりうる(普通のクライアントは 1 か所で更新するので影響はない)。
2. **KV の結果整合性がリフレッシュ直後のトークン利用に影響しないか**。KV の書き込みは別ロケーションに最大 60 秒ほどで反映される。更新直後に別ロケーションの isolate が古い `props` を読むと、失効済みの Backlog リフレッシュトークンで更新を試みる可能性がある(ローテーション有りの場合)。テストは Miniflare のローカル KV で行っており、この挙動は再現できない。M07 の実デプロイで確認する。
3. Backlog のアクセストークンの実際の `expires_in`(約 1 時間と想定)。実装は応答の `expires_in` をそのまま使う。
   - **確認済み(2026-10-29)**: 寿命は約 1 時間(02:57 に取得したトークンが 03:57 に 401)。**有効期限内の更新では、`expires_in` は残り寿命(残り秒数)で、同じアクセストークンが返る**(04:29 の更新: `expires_in: 1755`、`access_token_changed: false`。失効は 04:58 ごろ)。期限は延びない。初回(コード交換)の `expires_in` は未観測(V03)。
4. Backlog の `redirect_uri` 検証と、client_secret のフォーム送信が仕様どおりに通ること(logvalet のコード交換実装を参考にしたが、リフレッシュは logvalet に実装がなく、本リポジトリで新規)。
5. **保存した期限(`backlogExpiresAt`)より先に Backlog のアクセストークンが使えなくなることがある**(2026-10-29 に検証用 Worker で観測。原因は未特定)。
   - 観測(時刻はログの時刻): 02:57 に認可(Backlog のコード交換)→ 03:11〜03:56 に MCP の refresh_token による `/token` が十数回(すべて 200)→ 03:56:06 の `/token` で得た MCP トークンで `/mcp` を呼ぶと、03:57:00 から全ツールが HTTP 401(Logbutler が Backlog の 401 を変換したもの)→ 03:58 ごろの `/token` の後は正常に戻った。
   - 読み取れること: 保存期限が 02:57 + 約 1 時間(03:57)のままなら、03:26 以降の `/token` で必ず Backlog を更新する(閾値は残り 31 分)。03:56:06 に Backlog を更新しなかったなら、その時点で読んだ `props` の期限は 04:27 以降だった。つまり「どこかの `/token` で Backlog の更新は成功して期限は進んだが、実際に使えるアクセストークンの寿命は延びなかった」(例: Backlog が更新で失効間近の同じアクセストークンを返した、または `expires_in` と実際の寿命が違う)可能性が高い。KV の結果整合で古い `props` を読んだのなら期限は 03:57 のままで更新が起きるはずなので、この観測は KV だけでは説明できない。
   - ライブラリ側の確認(workers-oauth-provider 1.2.3 `dist/oauth-provider.js`): refresh_token grant で `tokenExchangeCallback` に渡る `props` は grant の `props`(旧アクセストークンのものではない)。callback が `newProps` / `accessTokenProps` を返さなければ、新しいアクセストークンにも grant の `props` が入る。Logbutler 側の期限計算(`now + expires_in * 1000`)にも単位の誤りはない。
   - 対策(回復性): `/mcp` で Backlog が 401 を返したら、その grant に印(KV の `backlog-stale:<userId>:<grantId>`、TTL 15 分、値は `1` だけ)を置き、次の MCP のトークン更新で期限に関係なく Backlog を更新する(成功したら印を消す。`src/auth/backlog-stale.ts`)。MCP クライアントは 401 → 更新 → 再呼び出しで回復する。ただし印も KV なので、`/mcp` と `/token` が別の colo で処理されると印がすぐには見えず、回復が最大 60 秒ほど遅れうる(V02 と同種)。
   - **確認済み(2026-10-29。原因の特定)**: 原因は Backlog が有効期限内の更新で同じアクセストークンを残り寿命つきで返すこと(上の 1・3)。当時の実装は残り 31 分未満で「更新」していたが、同じトークンが返るだけで実際の寿命は延びず、03:57 の失効で 401 になった。03:58 ごろの更新は失効後なので新しいトークンが出て回復した(05:00 に実測で確認: 失効後の更新は新しいトークン `expires_in: 3599`、ローテーションなし)。観測の経過: 04:19 の MCP refresh は `backlog_remaining_seconds: 2338, needs_refresh: false`、04:29 の MCP refresh は `backlog_token` `{"expires_in":1755,"refresh_token_rotated":false}` と `token_exchange` `{"needs_refresh":true,"refreshed":true,"access_token_changed":false,"access_token_ttl":1694}`。
   - 設計変更([ADR 0014](0014-backlog-refresh-only-after-expiry.md)): Backlog を更新するのは保存期限を過ぎたとき(残り 0 以下)と stale 印があるときだけ。Backlog から新しいトークンを得られなかったとき(呼ばなかった・同じトークンが返った)は、MCP の寿命を Backlog の残り + 5 秒(上限 30 分、下限 60 秒)にして、次の MCP の更新を失効直後に来させる。失効と次の更新の隙間の 401 は stale 印で回復する。上の「読み取れること」の「閾値は残り 31 分」は当時の実装の話。
   - 切り分け用の診断ログ(値は出さない): `backlog_token`(`expires_in`・`refresh_token_rotated`)、`token_exchange`(残り秒数・`needs_refresh`・`stale_marker`・`refreshed`・`access_token_changed`・`ttl_basis`)、`backlog_unauthorized`(401 時点の `props` 上の残り秒数)。次に起きたら、`access_token_changed: false` か、`backlog_unauthorized` の残り秒数が正(保存期限より前の失効)かを見る。確認手順は manual-verification の V01〜V03。
