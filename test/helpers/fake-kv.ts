/** 冪等キャッシュのテスト用 KV。保存したキー・値・TTL を調べられる。 */
export class FakeKv {
  readonly store = new Map<string, { value: string; expirationTtl?: number }>();
  gets: string[] = [];
  puts: string[] = [];
  failGet = false;
  failPut = false;

  async get(key: string): Promise<string | null> {
    this.gets.push(key);
    if (this.failGet) throw new Error("KV get failed");
    return this.store.get(key)?.value ?? null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.puts.push(key);
    if (this.failPut) throw new Error("KV put failed");
    this.store.set(key, { value, expirationTtl: options?.expirationTtl });
  }
}
