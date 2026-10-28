# ADR 0014: Backlog のトークンは失効後にだけ更新し、MCP の寿命を Backlog の残り寿命に合わせる

- 状態: 採用(2026-10-29。実環境の観測による設計変更)
- 関連: ADR 0001(Worker 自身を OAuth 認可サーバーにする。未検証の前提 1・3・5)、`src/auth/token-exchange.ts`、`src/auth/backlog-stale.ts`、[docs/manual-verification.md](../manual-verification.md) の V01・V03

## 背景

ADR 0001 の設計は「MCP のトークン(30 分)を発行するとき、Backlog の残りが 30 分 + 60 秒未満なら Backlog も先に更新する」だった。Backlog の更新で期限が延びることを前提にしている。

2026-10-29 に検証用 Worker の診断ログ(値は出さない)で次を観測した。

- 04:19 の MCP refresh: `token_exchange` が `backlog_remaining_seconds: 2338, needs_refresh: false`(Backlog の失効は 04:58 ごろ)。
- 04:29 の MCP refresh(残り 31 分未満なので Backlog も更新): `backlog_token` が `{"grant_type":"refresh_token","expires_in":1755,"refresh_token_rotated":false}`、`token_exchange` が `{"needs_refresh":true,"refreshed":true,"access_token_changed":false,"access_token_ttl":1694}`。
- それ以前(03:56)にも同じように「更新」して同じトークンが返り、03:57 に失効して全ツールが 401 になった。03:58 ごろの MCP refresh(失効後の Backlog 更新)の後に回復した。

つまり **Backlog は有効期限内のリフレッシュでは、同じアクセストークンを残り寿命(`expires_in` = 残り秒数)つきで返すだけで、期限は延びない**。リフレッシュトークンも変わらない。

これにより旧設計には次の問題があった。

1. 事前更新が効かない(同じトークンが返る)。
2. 返った残りが短いと MCP の寿命が `max(60, min(1800, 残り - 60))` で縮み、失効まで毎分 MCP の refresh と Backlog への無駄な更新が起きる。
3. 失効の瞬間は stale 印(Backlog の 401 → 印 → 次の MCP refresh で強制更新)でしか回復しない。

## 決定

`tokenExchangeCallback`(`src/auth/token-exchange.ts`)を次のようにする。

### Backlog を呼ぶ条件

- 保存した期限(`backlogExpiresAt`)を過ぎている(**残り 0 以下**)、または
- その grant に stale 印がある(`/mcp` で Backlog が 401 を返した。期限に関係なく更新し、成功したら印を消す。認可コード直後は見ない)。

期限内(残り > 0)は、残りが MCP の寿命より短くても Backlog を呼ばない。観測では期限内の更新は同じトークンと残り秒数を返すだけで、得るものがないため。閾値を 0 にする理由は次のとおり。

- 残りが正の間に呼んでも観測どおり同じトークンしか返らない(03:56 の更新は失効の約 1 分前でも同じトークンだった)。
- 残りが 60 秒未満の帯は、呼んでも呼ばなくても MCP トークン(KV の最小 60 秒)が Backlog の失効を追い越すので、失効と次の更新の間の 401 は避けられない。その隙間は stale 印で回復する。
- 保存期限は「応答を受けた時刻 + `expires_in`」なので、Backlog 側の実際の期限以後になる。残り 0 以下で呼べば Backlog 側でも失効済みになっている。

### MCP アクセストークンの寿命(`accessTokenTTL`)

| 場合 | 式 | ログの `ttl_basis` |
|---|---|---|
| Backlog から新しいトークンを得た(`access_token_changed: true`) | `max(60, min(1800, 残り - 60))`(従来どおり) | `new_token` |
| それ以外(Backlog を呼ばなかった・呼んだが同じトークンが返った) | `max(60, min(1800, 残り + 5))` | `backlog_remaining` |

- `残り` は秒(floor)。1800 は `MCP_ACCESS_TOKEN_TTL_SECONDS`、60 は KV の最小 TTL(ライブラリも 60 秒未満を拒否する)。
- 5 秒は `BACKLOG_EXPIRY_GRACE_SECONDS`。次の MCP の更新が Backlog の失効「直後」に来るようにして、そこで新しい Backlog トークンを得る。保存期限は Backlog の実際の期限以後なので数秒で足り、floor の切り捨てとライブラリ側の秒の数え方の ±1 秒を吸収できればよい。長くすると、失効から次の更新までの 401(stale 印で回復)の時間が延びるだけ。
- 同じトークンが返ったときも `props` の期限は返った残り寿命で保存し直す(延びていない期限が入る)。
- 呼ばなかった経路でも `残り - 60` を使うと、残り 60 秒で 60 秒のトークン → 残り 0 でもう 1 回、という無駄な refresh が残るので、式は「新しいトークンを得たか」の 2 本に分ける。

### 典型的な流れ(Backlog の寿命 3600 秒、クライアントは 10 分ごとに先行 refresh)

認可(MCP 1800 秒)→ 10・20・30 分: Backlog を呼ばず 1800 秒 → 40 分: 1205 秒 → 50 分: 605 秒 → 60 分 + 5 秒(Backlog の失効直後): Backlog を更新して新しいトークン、MCP 1800 秒。Backlog への更新は 1 時間に 1 回。

先行 refresh するクライアントでは、失効が近づくと MCP の寿命が縮むので MCP の refresh が失効直前に数回増える(下限 60 秒)。Backlog は呼ばないので、Backlog への無駄な更新はなくすことを優先し、これは許容する。

### 診断ログ

`backlog_token` と `token_exchange` は残し、`token_exchange` に `ttl_basis`(`new_token` / `backlog_remaining`)を足した。`needs_refresh` は「保存期限を過ぎている」の意味になる。値(トークン)は出さない。

## 却下した案

- **閾値を残すが小さくする(例: 残り 5 分未満で更新)**: 観測では期限内の更新は同じトークンを返すので、何秒前でも効果がなく、無駄な更新が増えるだけ。
- **同じトークンが返ったら残り - 60 秒の寿命にする(従来の式)**: 返った残りが短いと 60 秒のトークンになり、失効まで毎分 refresh と Backlog への無駄な更新が続く。
- **MCP の寿命を常に 60 秒にして頻繁に確認する**: MCP の refresh と KV の書き込みが増えるだけで、Backlog の失効は防げない。

## テスト

- unit(`test/unit/token-exchange.test.ts`): 期限内は残りが短くても Backlog を呼ばず寿命は残り + 5 秒、残り 0 は更新、stale 印で同じトークンが返ったときの寿命、上限・下限、ログの `ttl_basis`。
- E2E(`test/e2e/refresh.test.ts` の E2E 4b): Backlog を観測どおりの fake(`test/helpers/fake-backlog-oauth.ts`。期限内の更新は同じトークン + 残り秒数、失効後は新しいトークン、`/users/myself` は現在のトークンで期限内のときだけ 200)にして、10 分ごとの refresh で Backlog を呼ばないこと、失効直後の refresh で新しいトークンになりツールが 200 になること、隙間の 401 から stale 印で 1 回の refresh で回復することを確かめる。以前の E2E のモックは毎回新しいトークンを返していたため、この問題を見逃していた。

## 未確定の点

- **確認済み(2026-10-29 05:00)**: 失効後の更新では新しいアクセストークンが出る(`expires_in: 3599`、`refresh_token_rotated: false`)。2026-10-29 05:00 の検証用 Worker のログ: `backlog_token` `{"grant_type":"refresh_token","expires_in":3599,"refresh_token_rotated":false}`、`token_exchange` `{"backlog_remaining_seconds":-104,"needs_refresh":true,"refreshed":true,"access_token_changed":true,"ttl_basis":"new_token","access_token_ttl":1800}`。以下は、仮にこの挙動が変わった場合の備え: 失効後も同じトークン(`expires_in` が 0 以下)が返る場合でも、寿命は下限の 60 秒になり 1 分後に再試行するだけで壊れない。`invalid_grant` が返るなら grant を失効させる(従来どおり)。
- 初回(コード交換)の `expires_in` が常に 3600 か、既存の有効なトークンがあれば残り寿命を返すかは未観測(V03)。どちらでも上の式で扱える。
