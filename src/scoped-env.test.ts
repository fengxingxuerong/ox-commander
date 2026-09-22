import { describe, expect, it } from "vitest";
import { droppedSecretNames, isSecretName, scopedEnv } from "../electron/agents/scoped-env";

/**
 * The leak this guards: `dispatch()` passed `{ ...process.env }` to every CLI
 * agent, so a task routed to one CLI could read the API keys of every *other*
 * configured provider out of its own environment.
 */
const PARENT: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/op",
  SystemRoot: "C:\\Windows",
  APPDATA: "C:\\Users\\op\\AppData\\Roaming",
  LANG: "en_US.UTF-8",
  NODE_ENV: "production",
  // Credentials that must not reach an arbitrary child.
  SENSENOVA_API_KEY: "sk-sensenova-secret",
  DEEPSEEK_API_KEY: "sk-deepseek-secret",
  OPENAI_API_KEY: "sk-openai-secret",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  GITHUB_TOKEN: "ghp_secret",
  DB_PASSWORD: "hunter2",
  MY_SESSION_ID: "sess-123",
  // Ordinary configuration, still dropped because it is not a process basic.
  OX_UNRELATED_SETTING: "whatever",
};

describe("scopedEnv · credential denial", () => {
  it("drops every provider key when no provider is scoped in", () => {
    const env = scopedEnv({ parent: PARENT });
    // The whole point: an unrelated child must not inherit credentials.
    expect(env.SENSENOVA_API_KEY).toBeUndefined();
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("drops credential-shaped names that no provider declares", () => {
    const env = scopedEnv({ parent: PARENT });
    // Convention-based, so a new provider needs no registration to be safe.
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.DB_PASSWORD).toBeUndefined();
    expect(env.MY_SESSION_ID).toBeUndefined();
  });

  it("keeps the variables a child needs to actually run", () => {
    const env = scopedEnv({ parent: PARENT });
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/op");
    // Without SystemRoot many Windows tools fail to start at all.
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.APPDATA).toBe("C:\\Users\\op\\AppData\\Roaming");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.NODE_ENV).toBe("production");
  });

  it("drops unrelated non-secret configuration too", () => {
    // Allowlist semantics, not just a denylist: unlisted names do not flow through.
    expect(scopedEnv({ parent: PARENT }).OX_UNRELATED_SETTING).toBeUndefined();
  });

  it("never mutates the parent environment", () => {
    const before = { ...PARENT };
    scopedEnv({ parent: PARENT });
    expect(PARENT).toEqual(before);
  });
});

describe("scopedEnv · explicit grants", () => {
  it("re-admits a credential only when named in extraKeys", () => {
    const env = scopedEnv({ parent: PARENT, extraKeys: ["DEEPSEEK_API_KEY"] });
    expect(env.DEEPSEEK_API_KEY).toBe("sk-deepseek-secret");
    // The grant is per-name, so the sibling provider stays hidden.
    expect(env.SENSENOVA_API_KEY).toBeUndefined();
  });

  it("re-admits a provider key only for the provider scoped in", () => {
    const env = scopedEnv({ parent: PARENT, allowProviders: ["deepseek"] });
    expect(env.DEEPSEEK_API_KEY).toBe("sk-deepseek-secret");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("treats an explicit grant as winning over the secret denylist", () => {
    // Order matters: if the denylist ran last this would be undefined, and the
    // "explicit operator grant" would be unenforceable.
    const env = scopedEnv({ parent: PARENT, extraKeys: ["DB_PASSWORD"] });
    expect(env.DB_PASSWORD).toBe("hunter2");
  });

  it("passes through non-secret extraKeys", () => {
    const env = scopedEnv({ parent: PARENT, extraKeys: ["OX_UNRELATED_SETTING"] });
    expect(env.OX_UNRELATED_SETTING).toBe("whatever");
  });

  /**
   * 下面两条是 site 口径实测出的存活位点（本文件此前 `continue → break` 分不开）。
   * 共同根因与全仓多次出现的一样：**被跳过的项在既有用例里永远是最后一项**，
   * 于是「跳过本项继续」与「直接终止循环」行为完全一致。
   *
   * 这里的后果比"少抄几个变量"严重：改成 break 之后，
   * 只要**第一项**被跳过，后面**所有**环境变量都被丢弃 ——
   * 子进程会拿到一个几乎空的环境（PATH 都没有）。
   */
  it("[122] 值为 undefined 的项排在前面时，后面的变量照常传递", () => {
    // `if (value === undefined) continue;` —— 该分支此前零覆盖。
    // 键顺序即断言：UNDEFINED_FIRST 必须排在 PATH / HOME 之前。
    const env = scopedEnv({
      parent: {
        UNDEFINED_FIRST: undefined,
        PATH: "/usr/bin:/bin",
        HOME: "/home/op",
        LANG: "en_US.UTF-8",
      },
    });
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/op");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect("UNDEFINED_FIRST" in env).toBe(false);
  });

  it("[129] 显式授予的项排在前面时，后续变量不会被丢弃", () => {
    // grants 分支命中后的 `continue;` —— 此前该分支只出现在"授予项在最后"的用例里。
    // 键顺序即断言：DB_PASSWORD（被授予）排在最前，后面还有普通变量。
    const env = scopedEnv({
      parent: {
        DB_PASSWORD: "hunter2",
        PATH: "/usr/bin:/bin",
        HOME: "/home/op",
        NODE_ENV: "production",
      },
      extraKeys: ["DB_PASSWORD"],
    });
    expect(env.DB_PASSWORD).toBe("hunter2");
    // 授予项之后不能中断遍历 —— 否则这些进程基础变量全丢
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/op");
    expect(env.NODE_ENV).toBe("production");
  });
});

describe("scopedEnv · diagnostics", () => {
  it("reports dropped secret names but never their values", () => {
    const dropped = droppedSecretNames({ parent: PARENT });
    expect(dropped).toContain("OPENAI_API_KEY");
    expect(dropped).toContain("DB_PASSWORD");
    // Names only — this list is safe to log or render.
    expect(dropped.join(",")).not.toContain("hunter2");
    expect(dropped.join(",")).not.toContain("sk-");
  });

  it("excludes a name that was explicitly granted", () => {
    expect(droppedSecretNames({ parent: PARENT, extraKeys: ["DB_PASSWORD"] })).not.toContain("DB_PASSWORD");
  });
});

describe("isSecretName", () => {
  it.each([
    "SENSENOVA_API_KEY",
    "apiKey",
    "MY_SECRET",
    "AUTH_HEADER",
    "USER_PASSWORD",
    "PRIVATE_KEY",
    "ACCESS_KEY_ID",
    "GITHUB_TOKEN",
    "credentialsPath",
  ])("flags %s", (name) => {
    expect(isSecretName(name)).toBe(true);
  });

  it.each(["PATH", "HOME", "LANG", "NODE_ENV", "SystemRoot", "TERM"])("leaves %s alone", (name) => {
    expect(isSecretName(name)).toBe(false);
  });
});
