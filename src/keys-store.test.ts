import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  KeysStore,
  PLAINTEXT_CRYPTO,
  createSafeStorageCrypto,
  type SafeStorageLike,
  type SecretCrypto,
} from "../electron/keys-store";

const dirs: string[] = [];

function scratchFile(name = "keys.json"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-keys-"));
  dirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // temp cleaner
    }
  }
});

/** Deterministic stand-in for an OS keychain: reversible, obviously not the plaintext. */
function fakeCrypto(opts: { available?: boolean; failDecrypt?: boolean } = {}): SecretCrypto {
  const prefix = "enc::";
  return {
    available: () => opts.available ?? true,
    encrypt: (plain) => prefix + Buffer.from(plain, "utf8").toString("base64"),
    decrypt: (payload) => {
      if (opts.failDecrypt) throw new Error("cannot decrypt on this machine");
      if (!payload.startsWith(prefix)) throw new Error("not a ciphertext");
      return Buffer.from(payload.slice(prefix.length), "base64").toString("utf8");
    },
  };
}

describe("KeysStore basics", () => {
  it("round-trips a key when encryption is available", () => {
    const file = scratchFile();
    const store = new KeysStore(file, fakeCrypto());
    expect(store.set("SENSENOVA_API_KEY", "sk-secret")).toBe(true);
    expect(store.get("SENSENOVA_API_KEY")).toBe("sk-secret");
    expect(store.isEncryptedAtRest()).toBe(true);
  });

  it("never writes the plaintext to disk when encryption is available", () => {
    const file = scratchFile();
    new KeysStore(file, fakeCrypto()).set("SENSENOVA_API_KEY", "sk-secret");
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain("sk-secret");
    expect(JSON.parse(raw)).toMatchObject({ version: 2 });
  });

  it("falls back to plaintext and says so when there is no keychain", () => {
    const file = scratchFile();
    const store = new KeysStore(file, fakeCrypto({ available: false }));
    store.set("GLM_API_KEY", "glm-abc");
    expect(store.isEncryptedAtRest()).toBe(false);
    expect(store.plaintextCount()).toBe(1);
    expect(store.get("GLM_API_KEY")).toBe("glm-abc");
    expect(fs.readFileSync(file, "utf8")).toContain("glm-abc");
  });

  it("defaults to plaintext when no crypto is injected", () => {
    const file = scratchFile();
    const store = new KeysStore(file);
    store.set("K", "v");
    expect(store.isEncryptedAtRest()).toBe(false);
    expect(store.get("K")).toBe("v");
    expect(PLAINTEXT_CRYPTO.available()).toBe(false);
  });

  /**
   * `isEncryptedAtRest` 的 catch 分支原本没有任何断言（site 口径实测存活：
   * `return false → true` 无人发现）。
   *
   * 为什么这条重要：那个 `false` 是"加密能力探测失败"时的回答。改成 `true` 之后，
   * **密钥探测一失败，代码就会对外谎称"静态已加密"** —— 与"没有 keychain 时
   * 明确返回 false"是相反的安全语义。这类失败必须是"降级并如实报告"，
   * 而不是"降级但假装没降级"。
   */
  it("加密能力探测抛错时如实报告未加密，而不是谎报已加密", () => {
    const file = scratchFile();
    const boom: SecretCrypto = {
      available: () => {
        throw new Error("safeStorage unavailable in this environment");
      },
      encrypt: (plain) => `enc::${plain}`,
      decrypt: () => {
        throw new Error("not a ciphertext");
      },
    };
    const store = new KeysStore(file, boom);
    expect(store.isEncryptedAtRest()).toBe(false);
  });

  it("lets the environment win over the store", () => {
    const file = scratchFile();
    const store = new KeysStore(file, fakeCrypto());
    store.set("OX_TEST_KEY", "from-store");
    process.env.OX_TEST_KEY = "from-env";
    try {
      expect(store.get("OX_TEST_KEY")).toBe("from-env");
      expect(store.status(["OX_TEST_KEY"])).toEqual([
        { envVar: "OX_TEST_KEY", configured: true, source: "env" },
      ]);
    } finally {
      delete process.env.OX_TEST_KEY;
    }
  });

  it("reports configured when only the store has the key", () => {
    // No env var involved: `configured` must come from the store value alone —
    // the check is env ∪ store, not env ∩ store. (`get()` prefers env, so an
    // env-set case can never distinguish the two sides of that operator.)
    const file = scratchFile();
    const store = new KeysStore(file, fakeCrypto());
    store.set("OX_TEST_STORE_ONLY", "from-store");
    expect(store.status(["OX_TEST_STORE_ONLY"])).toEqual([
      { envVar: "OX_TEST_STORE_ONLY", configured: true, source: "store" },
    ]);
  });

  it("clears a key on a blank value and rejects a malformed name", () => {
    const file = scratchFile();
    const store = new KeysStore(file, fakeCrypto());
    store.set("A_B", "1");
    expect(store.set("A_B", "   ")).toBe(true);
    expect(store.get("A_B")).toBe("");
    expect(store.set("lower-case", "x")).toBe(false);
    expect(store.set("has space", "x")).toBe(false);
  });
});

describe("KeysStore legacy migration", () => {
  it("reads a v1 plaintext file", () => {
    const file = scratchFile();
    fs.writeFileSync(file, JSON.stringify({ SENSENOVA_API_KEY: "sk-old" }), "utf8");
    const store = new KeysStore(file, fakeCrypto());
    expect(store.get("SENSENOVA_API_KEY")).toBe("sk-old");
    expect(store.plaintextCount()).toBe(1);
  });

  it("keeps unrelated v1 keys when writing a new one", () => {
    const file = scratchFile();
    fs.writeFileSync(file, JSON.stringify({ OLD_KEY: "sk-old" }), "utf8");
    const store = new KeysStore(file, fakeCrypto());
    store.set("NEW_KEY", "sk-new");
    expect(store.get("OLD_KEY")).toBe("sk-old"); // still plaintext, not lost
    expect(store.get("NEW_KEY")).toBe("sk-new");
    expect(store.plaintextCount()).toBe(1);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { version: number };
    expect(raw.version).toBe(2);
  });

  it("upgrades a v1 value to ciphertext once it is re-saved", () => {
    const file = scratchFile();
    fs.writeFileSync(file, JSON.stringify({ SENSENOVA_API_KEY: "sk-old" }), "utf8");
    const store = new KeysStore(file, fakeCrypto());
    store.set("SENSENOVA_API_KEY", "sk-old");
    expect(store.plaintextCount()).toBe(0);
    expect(fs.readFileSync(file, "utf8")).not.toContain("sk-old");
    expect(store.get("SENSENOVA_API_KEY")).toBe("sk-old");
  });

  it("treats an undecryptable value as missing instead of crashing", () => {
    const file = scratchFile();
    new KeysStore(file, fakeCrypto()).set("SENSENOVA_API_KEY", "sk-secret");
    const otherMachine = new KeysStore(file, fakeCrypto({ failDecrypt: true }));
    expect(() => otherMachine.get("SENSENOVA_API_KEY")).not.toThrow();
    expect(otherMachine.get("SENSENOVA_API_KEY")).toBe("");
    expect(otherMachine.status(["SENSENOVA_API_KEY"])[0]!.configured).toBe(false);
  });

  it("survives a corrupt file", () => {
    const file = scratchFile();
    fs.writeFileSync(file, "{ not json", "utf8");
    const store = new KeysStore(file, fakeCrypto());
    expect(store.get("ANY")).toBe("");
    expect(store.set("ANY", "v")).toBe(true);
    expect(store.get("ANY")).toBe("v");
  });

  it("tolerates a BOM written by external tools", () => {
    const file = scratchFile();
    fs.writeFileSync(file, `\uFEFF${JSON.stringify({ K: "v" })}`, "utf8");
    expect(new KeysStore(file, fakeCrypto()).get("K")).toBe("v");
  });

  it("文件里是 null 时不崩，当作空 store", () => {
    // `parsed !== null && typeof parsed === "object"` 里的 `&&` 改成 `||` 后：
    // `typeof null === "object"` 恒真 → 整个条件恒真 → 走进 v1 迁移分支，
    // 然后 `Object.entries(null)` 抛 TypeError。
    // 而 `JSON.parse` 对 "null" 是**成功**的，所以"损坏文件"那条用例盖不到它。
    const file = scratchFile();
    fs.writeFileSync(file, "null", "utf8");
    const store = new KeysStore(file, fakeCrypto());
    expect(() => store.get("ANY")).not.toThrow();
    expect(store.get("ANY")).toBe("");
    expect(store.plaintextCount()).toBe(0);
  });

  it("v1 明文不会被 isV2 误判成 v2（守卫是全条件与，不是或）", () => {
    // `isV2` 由 5 个 `&&` 串成。任一改成 `||` 之后，**只要有一个条件成立**就返回 true，
    // 于是没有 `version` 的 v1 文件会被当成 v2 去读 `parsed.keys`（undefined），
    // 明文密钥读不回来 —— 症状是"配置莫名丢失"，而不是报错。
    const file = scratchFile();
    fs.writeFileSync(file, JSON.stringify({ SENSENOVA_API_KEY: "sk-old" }), "utf8");
    const store = new KeysStore(file, fakeCrypto());
    expect(store.get("SENSENOVA_API_KEY")).toBe("sk-old");
    expect(store.plaintextCount()).toBe(1);
  });
});

describe("createSafeStorageCrypto", () => {
  it("delegates to the Electron safeStorage API", () => {
    const calls: string[] = [];
    const fake: SafeStorageLike = {
      isEncryptionAvailable: () => {
        calls.push("available");
        return true;
      },
      encryptString: (plain) => {
        calls.push(`encrypt:${plain}`);
        return Buffer.from(`cipher(${plain})`, "utf8");
      },
      decryptString: (buf) => {
        calls.push("decrypt");
        return buf.toString("utf8").replace(/^cipher\(|\)$/g, "");
      },
    };
    const crypto = createSafeStorageCrypto(fake);
    expect(crypto.available()).toBe(true);
    const payload = crypto.encrypt("sk-secret");
    expect(payload).not.toContain("sk-secret"); // base64 of the wrapped value
    expect(crypto.decrypt(payload)).toBe("sk-secret");
    expect(calls).toContain("encrypt:sk-secret");
  });

  it("reports unavailable when the platform throws", () => {
    const crypto = createSafeStorageCrypto({
      isEncryptionAvailable: () => {
        throw new Error("no keyring");
      },
      encryptString: () => Buffer.from(""),
      decryptString: () => "",
    } as SafeStorageLike);
    expect(crypto.available()).toBe(false);
  });

  it("stores through a real KeysStore end to end", () => {
    const file = scratchFile();
    const crypto = createSafeStorageCrypto({
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`wrapped:${plain}`, "utf8"),
      decryptString: (buf) => buf.toString("utf8").replace(/^wrapped:/, ""),
    });
    const store = new KeysStore(file, crypto);
    store.set("SENSENOVA_API_KEY", "sk-secret");
    expect(fs.readFileSync(file, "utf8")).not.toContain("sk-secret");
    expect(store.get("SENSENOVA_API_KEY")).toBe("sk-secret");
  });
});
