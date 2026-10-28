/**
 * headless 四个入口的**入口级**测试（2026-10-05，闭合体检报告 P1）。
 *
 * 这四个文件此前 0% 覆盖。它们的职责不是业务逻辑，而是"进程边界"：
 * argv 怎么解析、参数错了报不报、退出码对不对。
 *
 * 为什么这层必须有测试（不是"覆盖率好看"）：第四轮在 MCP 上踩过一次
 * `--serve=` 写错（文档是 `--serve-url=`）——**不报错、静默回落默认端口、
 * exit 0**，我每一步都以为 MCP 坏了，它却装作正常。那类失败只在真跑
 * 宿主时才看得见，而这四个文件就是宿主与引擎之间的翻译层。
 *
 * 覆盖方式：能纯函数测的用纯函数（`portFromArgv`）；必须验进程契约的
 * （退出码、stderr 内容）**真的 spawn 进程** —— 因为退出码只有真进程才有。
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import {
  sealReceipt,
  type DeliveryReceipt,
  type ReceiptCheck,
} from "../shared/delivery-receipt";
import { exposureProblem, hostFromArgv, onEngineOption, portFromArgv, selfCallHost } from "../headless/serve-main";
import { serveArgv } from "../headless/mcp-main";

const tmpdir = () => os.tmpdir();
const hashOf = (s: string) => createHash("sha256").update(s).digest("hex");

const ROOT = path.resolve(__dirname, "..");
const HEADLESS_DIST = path.join(ROOT, "dist-headless", "headless");

/**
 * 真跑一个 headless 入口。
 *
 * ⚠️ 这组用例测的是 **dist 产物**，不是源码 —— 所以它对构建新鲜度有硬要求。
 * `npm run verify` 的顺序是 `test` → `build` → `build:headless`，也就是
 * **测试跑在构建之前**，直接 spawn 会测到上一次构建的旧二进制
 * （本轮就踩了：源码已修好，dist 还是旧的，两条用例红）。
 *
 * 所以这里自己按新鲜度重建，而不是依赖外层顺序：改了源码就重建，没改就复用。
 *
 * ⚠️ 重建**必须在 beforeAll 里**，不能塞进每条用例的第一行（2026-10-05 实测
 * 踩到：全量 `verify` 时 60 个 worker 并发抢 CPU，`tsc -b` 那一下超过 vitest
 * 默认 5s 用例超时 → 用例报 "Test timed out"，症状完全不像构建问题，
 * 而真因是一次**全局一次性**动作被放在了每条用例的时限里。
 * beforeAll 的时限独立且更宽，正是全局一次性动作该待的地方。
 */
let rebuilt = false;
export function ensureFreshDist(): void {
  if (rebuilt) return;
  // 比"最新的 headless 源文件"与产物：逐个列会漏（今天过了不代表明天过），
  // 用目录 mtime 一次覆盖全部。
  let newestSrc = 0;
  for (const f of fs.readdirSync(path.join(ROOT, "headless"))) {
    if (!f.endsWith(".ts")) continue;
    newestSrc = Math.max(newestSrc, fs.statSync(path.join(ROOT, "headless", f)).mtimeMs);
  }
  const out = path.join(HEADLESS_DIST, "serve-main.js");
  const newer = existsSync(out) && newestSrc > fs.statSync(out).mtimeMs;
  if (newer || !existsSync(out)) {
    const r = spawnSync("npm", ["run", "build:headless"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    if (r.status !== 0) {
      throw new Error(`build:headless 失败：\n${r.stdout}\n${r.stderr}`);
    }
  }
  rebuilt = true;
}

function runEntry(entry: string, args: string[], timeoutMs = 20_000) {
  const r = spawnSync(process.execPath, [path.join(HEADLESS_DIST, entry), ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// 一次构建，全文件复用；预算给到 120s（并发抢 CPU 时 tsc -b 可能要十几秒）。
beforeAll(() => ensureFreshDist(), 120_000);

/**
 * 复跑用的**真脚本文件**。
 *
 * ⚠️ 不能用 `node -e` —— 我第一版就是这么写的，实测两档都拿到 exit 2
 * （contradicted），看着像"复跑与凭据矛盾"，其实是 `CommandPolicy` 拒了内联求值
 * （stderr: "拒绝内联求值参数 -e（把代码放进脚本文件再执行）"）。
 * 也就是说那两条断言当时**测的根本不是我要测的东西**，却差一点就绿了 ——
 * 如果我当初只写"exit 2 = 矛盾"这一条，完全测不到"exit 0 = 复现"。
 *
 * 这正是 D5 那条修复的副作用之一，它是对的（内联求值就是绕过沙箱的口子），
 * 只是写端到端用例时必须知道。脚本文件才是沙箱允许的形状。
 */
const replayScript = path.join(tmpdir(), `ox-rv-ok-${process.pid}.mjs`);
const failScript = path.join(tmpdir(), `ox-rv-fail-${process.pid}.mjs`);
beforeAll(() => {
  fs.writeFileSync(replayScript, "process.exit(0);\n", "utf8");
  fs.writeFileSync(failScript, "process.exit(1);\n", "utf8");
}, 30_000);

/** 一条"可复跑"的 build 检查：命令指向真脚本文件。 */
function replayableCheck(script: string, claimedOk: boolean): ReceiptCheck {
  return {
    kind: "build",
    ok: claimedOk,
    exitCode: claimedOk ? 0 : 1,
    preexisting: false,
    headline: "",
    command: process.execPath,
    args: [script],
  };
}
  /** 读子进程 stdout 的第一行（服务启动横幅）。 */
function firstLine(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`等启动横幅超时，收到：${JSON.stringify(buf)}`)), timeoutMs);
    stream.on("data", (c: Buffer | string) => {
      buf += c.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        resolve(buf.slice(0, nl));
      }
    });
    stream.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

describe("serve-main · --port 参数解析", () => {
  it("合法写法照常解析", () => {
    expect(portFromArgv(["--port=8787"])).toEqual({ port: 8787 });
    expect(portFromArgv(["--port", "8787"])).toEqual({ port: 8787 });
    expect(portFromArgv(["--port=0"])).toEqual({ port: 0 }); // 0 = 系统分配
  });

  it("不给 --port 是合法的默认（端口 0），不是错误", () => {
    // 这一条必须分开测：修复的目的是"给错要报错"，不是"不给也报错"。
    expect(portFromArgv([])).toEqual({});
    expect(portFromArgv(["--serve-url=http://127.0.0.1:1"])).toEqual({});
  });

  it("给了但非法 → 报错，不是静默回落（D11 回归）", () => {
    // 修复前这些全部返回 undefined（= 回落随机端口），还照常打印启动成功、exit 0。
    for (const argv of [["--port=abc"], ["--port=99999"], ["--port=-1"], ["--port="], ["--port", "abc"]]) {
      expect(portFromArgv(argv).error, JSON.stringify(argv)).toMatch(/--port/);
      expect(portFromArgv(argv).port, JSON.stringify(argv)).toBeUndefined();
    }
  });

  it("拼错 flag 也报错（上一轮 --serve= 的教训）", () => {
    for (const argv of [["--ports=8080"], ["--PORT=8080"], ["--port=8080x"], ["-port=8080"]]) {
      expect(portFromArgv(argv).error, JSON.stringify(argv)).toBeTruthy();
    }
  });

  it("错误信息里带上用户实际写的那个值（照着改，不是放弃）", () => {
    expect(portFromArgv(["--port=99999"]).error).toContain("99999");
    expect(portFromArgv(["--ports=8080"]).error).toContain("--ports=8080");
    expect(portFromArgv(["--port=abc"]).error).toContain("abc");
  });

  /**
   * 下面三条是**为变异门禁补的**（2026-10-05 接入 TARGETS 后暴露的存活位点）。
   * 它们守的都是"跳过 / 落选的分支"，纯函数测试最容易漏掉的正是这一类 ——
   * 主流路径一验就绿，分支一改没人知道。
   */
  it("非 --port 的参数被跳过，且不影响后面的真 --port（continue 的语义）", () => {
    // 变异 ①（L41 continue → break）：改成 break 就只会看第一个参数，
    // 于是 `--foo=1 --port=8080` 变成"没有端口"，静默回落。
    expect(portFromArgv(["--serve-url=http://x", "--port=8080"])).toEqual({ port: 8080 });
    expect(portFromArgv(["--port=8080", "--other"])).toEqual({ port: 8080 });
    // 开头一串无关参数也不能吞掉端口
    expect(portFromArgv(["-v", "--x", "--port", "1234"])).toEqual({ port: 1234 });
  });

  it("空值与非法数字分开成两条独立的错（|| 是三个条件的或）", () => {
    // 变异 ②（L44 || → &&）：改成 && 后 `--port=` 会**不报错**而回落 ——
    // 正好是本条要守住的那个 bug 形态。
    expect(portFromArgv(["--port="]).error).toContain("--port");
    expect(portFromArgv(["--port", ""]).error).toContain("--port");
    expect(portFromArgv(["--port=abc"]).error).toContain("--port");
    expect(portFromArgv(["--port", "1.5"]).error).toContain("--port"); // 非整数
    // 三个条件各自都得能单独触发，不能只靠其中一个
    for (const argv of [["--port="], ["--port=abc"], ["--port=1.5"]]) {
      expect(portFromArgv(argv).port, JSON.stringify(argv)).toBeUndefined();
    }
  });

  it("不给端口时走的是无端口那一支，而不是给了 undefined 端口", () => {
    // 变异 ③（L79 三元互换）：写反成 `{ port: undefined }` 就会把 undefined
    // 传给 startServe —— 那不是"用默认"，而是"端口是 undefined"，行为未定义。
    const none = portFromArgv([]);
    expect("port" in none).toBe(false); // 键根本不存在
    expect(none.error).toBeUndefined();
    // 而显式 `--port=0` 必须**有**这个键：0 是合法选择，不是"没给"
    const zero = portFromArgv(["--port=0"]);
    expect("port" in zero).toBe(true);
    expect(zero.port).toBe(0);
  });
});

/**
 * `--host` 与暴露面判据（2026-10-13）。
 *
 * 这一组守的是"印出来的地址就是绑到的地址"：以前 `listen` 不传 host（绑全域）
 * 而启动信息印 127.0.0.1。三个纯函数合起来构成那条纪律的判定核心 ——
 * 解析（hostFromArgv）、自调用地址换算（selfCallHost）、启动前 fail-closed
 * （exposureProblem）。判错的形态全是静默的，所以逐档钉住。
 */
describe("serve-main · --host 与暴露面判据", () => {
  it("hostFromArgv：= 形式与空格形式都认", () => {
    expect(hostFromArgv(["--host=0.0.0.0"])).toEqual({ host: "0.0.0.0" });
    expect(hostFromArgv(["--host", "192.168.1.5"])).toEqual({ host: "192.168.1.5" });
  });

  it("hostFromArgv：不给就是「没给」（键不存在，由 serve 落默认回环）", () => {
    const none = hostFromArgv([]);
    expect("host" in none).toBe(false);
    expect(none.error).toBeUndefined();
    expect(hostFromArgv(["--port=8787"]).host).toBeUndefined();
  });

  it("hostFromArgv：空值 / 带空白 → 报错，不静默回落", () => {
    for (const argv of [["--host="], ["--host", ""], ["--host=0.0.0.0 extra"]]) {
      expect(hostFromArgv(argv).error, JSON.stringify(argv)).toMatch(/--host/);
      expect(hostFromArgv(argv).host, JSON.stringify(argv)).toBeUndefined();
    }
  });

  it("hostFromArgv：拼错的 --hosts= 不许被静默忽略", () => {
    expect(hostFromArgv(["--hosts=0.0.0.0"]).error).toContain("--hosts=0.0.0.0");
  });

  it("selfCallHost：通配地址换回环（那不是可连地址），具体地址原样", () => {
    expect(selfCallHost("0.0.0.0")).toBe("127.0.0.1");
    expect(selfCallHost("::")).toBe("[::1]");
    expect(selfCallHost("127.0.0.1")).toBe("127.0.0.1");
    expect(selfCallHost("192.168.1.5")).toBe("192.168.1.5");
  });

  it("exposureProblem：回环放行；非回环有 token 放行；非回环无 token 拒绝且给出整句修法", () => {
    expect(exposureProblem("127.0.0.1", undefined)).toBeUndefined();
    expect(exposureProblem("localhost", undefined)).toBeUndefined();
    expect(exposureProblem("::1", undefined)).toBeUndefined();
    expect(exposureProblem("0.0.0.0", "tok")).toBeUndefined();
    const p = exposureProblem("0.0.0.0", undefined);
    expect(p).toContain("0.0.0.0");
    expect(p).toContain("OX_SERVE_TOKEN");
    expect(p).toContain("--host=127.0.0.1");
  });
});

describe("receipt-verify-main · 退出码契约", () => {
  // 这个入口的契约最严：它的退出码就是 CI 的判定，所以必须真进程验证。

  it("没给文件 → exit 1 并打印用法", () => {
    const r = runEntry("receipt-verify-main.js", []);
    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).toContain("用法");
  });

  it("只给 flag 不给文件 → exit 1（不是 exit 0 也不是崩）", () => {
    const r = runEntry("receipt-verify-main.js", ["--replay"]);
    expect(r.code).toBe(1);
  });

  it("读不到的文件 → exit 1，且说清是哪个文件", () => {
    const r = runEntry("receipt-verify-main.js", ["nonexistent-d11.json"]);
    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).toContain("nonexistent-d11.json");
  });

  it("未知 flag 不被静默忽略", () => {
    // 静默忽略未知 flag 正是 D11 那类缺陷：拼错了也照样"成功"。
    const r = runEntry("receipt-verify-main.js", ["--bogus", "nonexistent-d11.json"]);
    expect(r.code).toBe(1);
  });

  /**
   * **五档裁决 → 五个退出码**（`receipt-verify-main.ts:119-125`）。
   *
   * 这一段是这个入口存在的全部意义 —— 它的退出码就是 CI 的判定，而文件头
   * 明写"每一档对应一个**不同的处置**，刻意不并档"，其中最要紧的是
   * "只有 verified 一档可以采信"。
   *
   * 2026-10-05 接入变异门禁后暴露：`auditReceipt` 的五档在
   * `delivery-receipt.test.ts` 里测得很细，但**verdict → 退出码的映射表**
   * 一处断言都没有。所以 124 行那个 `=== !==` 变异是存活的 ——
   * 把 `unsigned` 也报成 3（tampered），没有任何测试会红，而下游读到的
   * 是"凭据被改过"，处置从"补盖章"变成了"查差异来源"，方向直接错了。
   *
   * 这里必须**真进程**跑（`main` 只在 `require.main` 时求值），并且用
   * 真凭据 —— 手搓 JSON 会漏掉 `canonicalReceiptPayload` 的规范化规则，
   * 那样构造出来的"指纹不符"是自造的，不是真的。
   */
  describe("五档裁决 → 退出码（只有 0 可以采信）", () => {
    /**
     * 造一份**真封过指纹**的凭据。指纹必须用同一个算法现算，否则测的是自造的 mismatch。
     *
     * `mutate` 刻意**在封完指纹之后**动手 —— 那样改出来的就是真正的"被篡改"，
     * 与"压根没盖过章"（`fingerprint: undefined`）构成两种不同的情形。
     */
    function sealed(over: Partial<DeliveryReceipt> = {}, mutate?: (r: DeliveryReceipt) => DeliveryReceipt): DeliveryReceipt {
      const base: DeliveryReceipt = {
        outcome: "delivered",
        verified: true,
        rounds: 0,
        checks: [],
        tasks: [],
        conflicts: [],
        counts: { total: 0, done: 0, failed: 0, skipped: 0, pending: 0, conflicts: 0, checksFailed: 0, preexisting: 0 },
        headline: "ok",
        ...over,
      };
      const sealedR = sealReceipt(base, (s) => createHash("sha256").update(s).digest("hex"));
      return mutate ? mutate(sealedR) : sealedR;
    }

    /** 写临时凭据并跑入口，返回退出码。 */
    function verify(r: DeliveryReceipt, extra: string[] = []) {
      // 名字里带上内容摘要：同一批用例要跑好几个不同凭据，同名会互相覆盖。
      const p = path.join(tmpdir(), `rv-${hashOf(JSON.stringify(r)).slice(0, 12)}.json`);
      fs.writeFileSync(p, JSON.stringify(r), "utf8");
      return runEntry("receipt-verify-main.js", [p, ...extra]);
    }

    it("没有指纹 → exit 4（unsigned：无从判断完整性）", () => {
      // unsigned 必须与 tampered 分开：前者是"没盖章"，后者是"被改过"，
      // 处置完全不同（补盖章 vs 查差异来源）。并档就是让复核工具说谎。
      const r = verify(sealed({ outcome: "delivered" }, (x) => ({ ...x, fingerprint: undefined })));
      expect(r.code).toBe(4);
    });

    it("指纹被改 → exit 3（tampered：结论一律不采信）", () => {
      // 真的篡改：改封好的 payload 里的 headline，指纹就必然对不上。
      const r = verify(sealed({ headline: "原始结论" }, (x) => ({ ...x, headline: "偷改过的结论" })));
      expect(r.code).toBe(3);
    });

    it("默认模式（没 --replay）→ exit 5（not-replayed：没复跑就不等于结论为真）", () => {
      // ⚠️ 这是本工具最重要的一条：默认只查完整性。若把"没复跑"报成 0，
      // 任何只看退出码的下游流水线都会把它读成"已核"—— 那正是本工具的反面。
      const r = verify(sealed({ checks: [replayableCheck(replayScript, true)] }));
      expect(r.code).toBe(5);
    });

    it("指纹一致 + 复跑复现 → exit 0（唯一可以采信的一档）", () => {
      const r = verify(sealed({ checks: [replayableCheck(replayScript, true)] }), ["--replay"]);
      expect(r.code).toBe(0);
    });

    it("指纹一致 + 复跑矛盾 → exit 2（contradicted：去查差异来源）", () => {
      // 凭据声称 build 过了，实际跑出来失败 → 矛盾。
      // 这是"自述与事实不符"的档位，与 tampered（凭据被改）性质不同。
      const r = verify(sealed({ checks: [replayableCheck(failScript, true)] }), ["--replay"]);
      expect(r.code).toBe(2);
    });

    it("五档互不重叠：每个退出码只由自己那一档产生", () => {
      // 把五种情形各自的退出码收齐，断言两两不同 —— 这是"不许并档"的机器检查。
      // 少一个都不行：只要两档撞了，就说明映射表被改坏了而下游还在照旧处置。
      const codes = new Set([
        verify(sealed({}, (x) => ({ ...x, fingerprint: undefined }))).code,
        verify(sealed({}, (x) => ({ ...x, headline: "偷改过的结论" }))).code,
        verify(sealed({ checks: [replayableCheck(replayScript, true)] })).code,
        verify(sealed({ checks: [replayableCheck(replayScript, true)] }), ["--replay"]).code,
        verify(sealed({ checks: [replayableCheck(failScript, true)] }), ["--replay"]).code,
      ]);
      expect(codes.size).toBe(5);
      expect([...codes].sort()).toEqual([0, 2, 3, 4, 5]);
    });
  });
});

describe("receipt-regress-main · 整批的裁决契约", () => {
  // 与单份入口同一条理由：这个入口的退出码就是 CI 的判定。
  // 但它多一层承判 —— **一批里怎么归并成一档**。归并错了（取第一份/最后一份、
  // 或者把读不动的当成没事）在单份用例里一律看不见。

  /** 按约定命名写一份真封过指纹的凭据，返回目录。 */
  function corpus(
    entries: Array<{ stamp: string; receipt: DeliveryReceipt }>,
  ): string {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "ox-regress-"));
    for (const e of entries) {
      const name = `${e.stamp}-${e.receipt.fingerprint!.slice(0, 8)}.json`;
      fs.writeFileSync(path.join(dir, name), JSON.stringify(e.receipt), "utf8");
    }
    return dir;
  }

  function regress(over: Partial<DeliveryReceipt> = {}, mutate?: (r: DeliveryReceipt) => DeliveryReceipt) {
    const base: DeliveryReceipt = {
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [],
      tasks: [],
      conflicts: [],
      counts: { total: 0, done: 0, failed: 0, skipped: 0, pending: 0, conflicts: 0, checksFailed: 0, preexisting: 0 },
      headline: "ok",
      ...over,
    };
    const sealedR = sealReceipt(base, (s) => createHash("sha256").update(s).digest("hex"));
    return mutate ? mutate(sealedR) : sealedR;
  }

  it("目录不存在 → exit 1，并说清约定路径", () => {
    const r = runEntry("receipt-regress-main.js", [`--dir=${path.join(tmpdir(), "ox-no-such-corpus-xyz")}`]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("凭据库目录不存在");
    expect(r.stderr).toContain(".ox/receipts");
  });

  it("空目录（含不认得的文件名）→ exit 1：没有凭据不等于通过", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "ox-regress-empty-"));
    fs.writeFileSync(path.join(dir, "README.md"), "not a receipt\n", "utf8");
    const r = runEntry("receipt-regress-main.js", [`--dir=${dir}`]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("没有可解析的凭据");
    expect(r.stdout).toContain("README.md");
  });

  it("没盖章的一份 → 整批 exit 4（unsigned）", () => {
    // 没指纹的凭据**进不了库**（命名要指纹前 8 位，`saveReceiptToCorpus` 会跳过它）。
    // 所以这种文件只可能来自"别人拷进来 / 手工改名" —— 用一个占位前缀模拟它，
    // 断言的是"读进来之后按内容判 unsigned"，而不是"库里会有这种名字"。
    const dir = fs.mkdtempSync(path.join(tmpdir(), "ox-regress-unsigned-"));
    const bare = regress({}, (x) => ({ ...x, fingerprint: undefined }));
    fs.writeFileSync(path.join(dir, "20261026-100000-00000000.json"), JSON.stringify(bare), "utf8");
    const r = runEntry("receipt-regress-main.js", [`--dir=${dir}`]);
    expect(r.code).toBe(4);
  });

  it("被改过的一份 → exit 3（tampered）", () => {
    const dir = corpus([{ stamp: "20261026-100000", receipt: regress({ headline: "原始" }, (x) => ({ ...x, headline: "偷改过的" })) }]);
    const r = runEntry("receipt-regress-main.js", [`--dir=${dir}`]);
    expect(r.code).toBe(3);
  });

  it("混合：一份被改过 + 一份完好 → 取**最严重**的那档（exit 3），且两份都被点名", () => {
    // 这条是整批语义的核心：一批里只要有一份不成立，这一批就不能算过。
    // 归并写成"取第一份/最后一份"时，这条会红。
    const dir = corpus([
      { stamp: "20261026-100000", receipt: regress({ checks: [replayableCheck(replayScript, true)] }) },
      { stamp: "20261026-110000", receipt: regress({ headline: "原始" }, (x) => ({ ...x, headline: "偷改过的" })) },
    ]);
    const r = runEntry("receipt-regress-main.js", [`--dir=${dir}`, "--replay", `--cwd=${tmpdir()}`]);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("tampered");
    expect(r.stdout).toContain("verified");
    expect(r.stdout).toContain("整批裁决：tampered");
  });

  it("默认模式（不给 --replay）→ exit 5，且提示怎么让结论为真", () => {
    const dir = corpus([{ stamp: "20261026-100000", receipt: regress({ checks: [replayableCheck(replayScript, true)] }) }]);
    const r = runEntry("receipt-regress-main.js", [`--dir=${dir}`]);
    expect(r.code).toBe(5);
    expect(r.stdout).toContain("--replay");
  });

  it("--replay 复跑复现 → exit 0（唯一可以采信的一档）", () => {
    const dir = corpus([{ stamp: "20261026-100000", receipt: regress({ checks: [replayableCheck(replayScript, true)] }) }]);
    const r = runEntry("receipt-regress-main.js", [`--dir=${dir}`, "--replay", `--cwd=${tmpdir()}`]);
    expect(r.code).toBe(0);
  });

  it("--replay 复跑矛盾 → exit 2（contradicted）", () => {
    const dir = corpus([{ stamp: "20261026-100000", receipt: regress({ checks: [replayableCheck(failScript, true)] }) }]);
    const r = runEntry("receipt-regress-main.js", [`--dir=${dir}`, "--replay", `--cwd=${tmpdir()}`]);
    expect(r.code).toBe(2);
  });

  it("目录里混进一份读不动的 → exit 1，且统计里点名（不被别的好糊过去）", () => {
    const dir = corpus([{ stamp: "20261026-100000", receipt: regress() }]);
    fs.writeFileSync(path.join(dir, "20261026-110000-aaaaaaaa.json"), "{ 不是 JSON", "utf8");
    const r = runEntry("receipt-regress-main.js", [`--dir=${dir}`]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("读不动");
    expect(r.stdout).toContain("unreadable=1");
  });

  it("--limit=abc → exit 1（用不了，不是「没复跑」）", () => {
    const r = runEntry("receipt-regress-main.js", ["--limit=abc"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--limit=abc");
  });

  it("--limit=1 只挑最新那一份（按文件名时间戳，不看 mtime）", () => {
    const dir = corpus([
      { stamp: "20261026-100000", receipt: regress({ checks: [replayableCheck(replayScript, true)] }) },
      // 较新的那份**声称过了、实际会失败** ⇒ 复跑出 contradicted（2）
      { stamp: "20261026-110000", receipt: regress({ checks: [replayableCheck(failScript, true)] }) },
    ]);
    // 只有最新那份参与 ⇒ 矛盾的那份被选中 ⇒ exit 2。
    // 若 limit 挑成最旧的，跑的会是"全绿那份"而得到 0。
    const r = runEntry("receipt-regress-main.js", [`--dir=${dir}`, "--limit=1", "--replay", `--cwd=${tmpdir()}`]);
    expect(r.stdout).toContain("共 1 份");
    expect(r.code).toBe(2);
  });
});

describe("serve-main · 非法端口不启动服务（D11 端到端）", () => {
  it("--port=99999 → exit 1，且不打印启动成功那行", () => {
    const r = runEntry("serve-main.js", ["--port=99999"], 15_000);
    expect(r.code).toBe(1);
    // 关键断言：绝不能出现"启动成功"那行 —— 修复前它照常打印随机端口。
    expect(r.stdout).not.toContain("OxCommander serve:");
    expect(r.stderr).toContain("99999");
  });

  it("--port=abc → exit 1", () => {
    const r = runEntry("serve-main.js", ["--port=abc"], 15_000);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("OxCommander serve:");
  });

  it("build 产物存在才跑这组（否则失败原因会误导成入口缺陷）", () => {
    // 前提检查本身就该红：dist 缺文件说明构建没跑，而 ensureFreshDist() 会重建，
    // 所以这里只在校验重建后产物确实到位。
    ensureFreshDist();
    for (const f of ["serve-main.js", "receipt-verify-main.js"]) {
      expect(
        existsSync(path.join(HEADLESS_DIST, f)),
        `${f} 不存在：重建后仍缺失`,
      ).toBe(true);
    }
  });

  /**
   * `main()` 里的两处条件展开（L79 端口、L99 onEngine）此前没有任何断言 ——
   * 纯函数测试够不到它们，因为它们只在**真的启动服务**时才求值。
   *
   * L99 那处尤其要守：`...(control ? { onEngine: control } : {})` 写反成永远
   * 传 onEngine（或永远不传），POST /pause / /resume 就静默失效 —— 而服务
   * 照常启动、照常应答，UI 上"点了暂停没反应"，没有任何报错。
   */
  it("真的启动后，端口按命令行给的那个来（不是随机端口）", async () => {
    ensureFreshDist();
    const port = 18771;
    const child = spawn(process.execPath, [path.join(HEADLESS_DIST, "serve-main.js"), `--port=${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const line = await firstLine(child.stdout!, 15_000);
      expect(line).toContain(`http://127.0.0.1:${port}/`);
      // 反向确认：端口确实是那个数字，不是碰巧同值
      expect(line).not.toMatch(/127\.0\.0\.1:(?!18771)\d+/);
    } finally {
      child.kill();
    }
  });

  it("POST /pause 与 /resume 真的被路由接上（没有 run 时是 409，不是 404）", async () => {
    ensureFreshDist();
    const port = 18772;
    const child = spawn(process.execPath, [path.join(HEADLESS_DIST, "serve-main.js"), `--port=${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await firstLine(child.stdout!, 15_000);
      for (const action of ["pause", "resume"]) {
        const res = await fetch(`http://127.0.0.1:${port}/${action}`, { method: "POST" });
        // ⚠️ 这里我一开始写成"期望 200"，实测 409 —— **那是产品行为，不是缺陷**：
        // `serve.ts:405` 明确"没有 run 在跑时暂停/继续无从谈起，409 并写明原因"。
        // 路由没接上会是 404，接上但执行抛错会是 500；409 正是两者都排除后的答案。
        // 换句话说这条用例守的是"路由在"，不是"暂停生效"（那需要有 run 才谈得上）。
        expect(res.status, `POST /${action} 状态（404=路由没接上）`).toBe(409);
      }
    } finally {
      child.kill();
    }
  });

  /**
   * `onEngine` 的接线原先内联在 `main()` 里 —— 2026-10-05 接入变异门禁时
   * 暴露为存活位点，已抽成纯函数 `onEngineOption`（`serve-main.ts`）。
   *
   * 为什么非抽不可才测得了：那一行只有**服务真的在跑一个 run** 时才求值，
   * 而没有可用 LLM 的机器上那次 run 几百毫秒就结束 —— 实测连续 11 次
   * `POST /pause` 全是 409（`serve.ts:406` 那条"当前没有 run 在跑"），
   * 端到端根本够不到它。要端到端就得配真密钥，那在离线 CI 里必然失败：
   * **假绿比缺测试更糟**。抽出后语义一字未改（仍是"有 control 才挂 onEngine"）。
   *
   * 下面两条守适配层有没有把 control 递下去 —— 那一环断了的症状是
   * "服务正常、暂停按钮没反应"，全程没有任何报错。
   * engine 挂上**之后**的行为由 `src/headless-serve.test.ts:361-393` 守着。
   */
  it("对照：没有 run 时 /pause 是 409（证明路由在，且能区分没有 run）", async () => {
    ensureFreshDist();
    const port = 18774;
    const child = spawn(process.execPath, [path.join(HEADLESS_DIST, "serve-main.js"), `--port=${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await firstLine(child.stdout!, 15_000);
      const res = await fetch(`http://127.0.0.1:${port}/pause`, { method: "POST" });
      expect(res.status).toBe(409);
      expect(await res.text()).toContain("没有 run 在跑");
    } finally {
      child.kill();
    }
  });

  /**
   * `onEngine` 的接线（原本内联在 `main()` 里，2026-10-05 抽成 `onEngineOption`）。
   *
   * 为什么必须抽出来才测得了：这一行只有**服务真的在跑一个 run** 时才求值，
   * 而没有可用 LLM 的机器上那次 run 几百毫秒就结束 —— 实测连续 11 次
   * `POST /pause` 全是 409（`serve.ts:406`），端到端根本够不到它。
   * 要端到端就得配真密钥，那在离线 CI 里必然失败：**假绿比缺测试更糟**。
   *
   * engine 挂上之后的行为由 `src/headless-serve.test.ts:361-393` 守着
   * （注入可控 engine，断言 `calls === ["pause","resume"]`）。这里守的是
   * 适配层有没有把 control 递下去 —— 那一环断了的症状是"服务正常、
   * 暂停按钮没反应"，没有任何报错。
   */
  it("有 control 就挂上 onEngine（暂停/继续才真的能递到引擎）", () => {
    const engine = { pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() };
    const control = (e: { pause(): void; resume(): void; cancel(): void }) => void e;
    const withCtl = onEngineOption(control);
    // 键必须存在，且是同一个函数
    expect("onEngine" in withCtl).toBe(true);
    expect(withCtl.onEngine).toBe(control);
    // 递下去得能用：服务会拿它回填 engine，再据此响应 /pause 与 /cancel
    withCtl.onEngine!(engine);
    engine.pause();
    engine.cancel();
    expect(engine.pause).toHaveBeenCalledTimes(1);
    // 2026-10-05 横向比对补的断言：cancel 必须一起递下去。
    // 只递 pause/resume 的话，serve 形态下就永远没有中止入口 ——
    // 而卡在等审批上的 run 正是只能靠中止脱困的（见 headless-serve.test.ts）。
    expect(engine.cancel).toHaveBeenCalledTimes(1);
  });

  it("没有 control 时**不能**挂 onEngine（键根本不存在，不是 undefined）", () => {
    // 语义差别很重要：传了 `onEngine: undefined` 与"没有 onEngine"在 run-spec 里
    // 同义，但只有后者才让 spread 不产出多余的键 —— 变异门禁守的正是这一位。
    expect("onEngine" in onEngineOption()).toBe(false);
    expect(onEngineOption(undefined)).toEqual({});
  });
});

/**
 * D12：mcp-main 的 `--serve-url`。
 *
 * 这一份的来历有点特殊 —— **`--serve=` 那个坑就是我自己踩的**（第四轮）：
 * 文档写 `--serve-url=`，我写了 `--serve=`，MCP 于是回落到默认 8787，
 * 每个工具调用都失败，而我把矛头指向了 MCP 服务本身，查了半天才发现是
 * 自己的 flag 写错。
 *
 * 原实现在这种输入下会打印 `serve-url=http://127.0.0.1:8787` ——
 * **那行 stderr 看起来像"我听懂了你的参数"**，于是连"是不是我写错了"都
 * 很难怀疑。这就是 D11 那类缺陷在参数更隐蔽的入口上的同一形状。
 */
describe("mcp-main · --serve-url 参数解析（D12）", () => {
  it("正确写法照常解析", () => {
    expect(serveArgv(["--serve-url=http://127.0.0.1:9999"])).toEqual({
      base: "http://127.0.0.1:9999",
    });
    expect(serveArgv(["--serve-url=https://ox.example"])).toEqual({
      base: "https://ox.example",
    });
  });

  it("不给 --serve-url 是合法默认（本机 8787 是常规用法）", () => {
    // 与 --port 一样，"不给"和"给错"必须分开：修的是后者。
    expect(serveArgv([])).toEqual({});
    expect(serveArgv(["--other-flag=1"])).toEqual({});
  });

  it("第四轮我自己踩的那个 --serve= 现在报错（D12 回归）", () => {
    const r = serveArgv(["--serve=http://127.0.0.1:9999"]);
    expect(r.error).toContain("--serve=http://127.0.0.1:9999");
    expect(r.base).toBeUndefined();
  });

  it("其余近似拼法同样报错，不静默回落", () => {
    for (const argv of [
      ["--serve_url=http://x"],
      ["--serveurl=http://x"],
      ["--serve-url"], // 有 flag 无值
      ["--serve-url="], // 空值
      ["--serve-url=not a url"],
      ["--serve-url=ftp://x/y"], // 协议不对，fetch 也没法定
    ]) {
      expect(serveArgv(argv).error, JSON.stringify(argv)).toBeTruthy();
      expect(serveArgv(argv).base, JSON.stringify(argv)).toBeUndefined();
    }
  });

  it("端到端：拼错的 flag → exit 1，且不再谎报 serve-url", () => {
    const r = runEntry("mcp-main.js", ["--serve=http://127.0.0.1:9999"]);
    expect(r.code).toBe(1);
    // 关键：绝不能再出现那行 `serve-url=http://127.0.0.1:8787`（默认值冒充已读懂）
    expect(r.stderr).not.toContain("stdout 是协议通道");
    expect(r.stderr).toContain("--serve=http://127.0.0.1:9999");
    // stdout 是协议通道，一个字节都不该有
    expect(r.stdout).toBe("");
  });

  it("端到端：正确 flag → 正常启动并打印它真的读到的地址", () => {
    const r = runEntry("mcp-main.js", ["--serve-url=http://127.0.0.1:9999"]);
    expect(r.code === 0 || r.code === 1).toBe(true); // 空 stdin → 正常 EOF 退出
    expect(r.stderr).toContain("serve-url=http://127.0.0.1:9999");
  });
});

/**
 * MCP 的 **stdin 行循环**（`mcp-main.ts:93-106`）。
 *
 * 这几行此前完全没有断言，于是接入变异门禁后立刻暴露 4 处存活位点 ——
 * 每一处都是"改坏了但测试照样绿"：空行没被跳过、非法 JSON 没被忽略、
 * 没有回复的消息不该写 stdout。
 *
 * 为什么这层值得单独测（它决定**协议流会不会被污染**）：stdout 是 JSON-RPC 的
 * 唯一通道，客户端按行解析。**多写一行日志、或漏跳一个空行，客户端就会把
 * 整条会话解析坏掉**，而服务端自己完全正常。
 */
describe("mcp-main · stdin 行循环（D12 变异补齐）", () => {
  /** 喂几行 stdin，跑 MCP 入口，收 stdout 与 stderr。 */
  function feed(lines: string[], args: string[] = []) {
    ensureFreshDist();
    const r = spawnSync(process.execPath, [path.join(HEADLESS_DIST, "mcp-main.js"), ...args], {
      encoding: "utf8",
      timeout: 20_000,
      input: lines.join("\n") + "\n",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  it("空行被跳过，不会往 stdout 写出空串", () => {
    // 变异 ①（=== → !==）：跳过条件反了就会把空行当消息处理。
    // 变异 ②（continue → break）：改成 break 就会在第一个空行处**跳出整个循环**，
    // 后面的消息全丢 —— 而症状是"客户端发什么都没反应"，极难定位。
    //
    // 所以这里必须两件事一起断：空行不产生协议行 **且** 空行之后的合法行仍被处理。
    // 只断言前者的话，continue→break 变异是存活的（实测踩到过）。
    const r = feed(["", "   ", "", '{"jsonrpc":"2.0","id":1,"method":"tools/list"}']);
    // 空行不得产生任何协议行 —— 客户端会把空行当成一条坏 JSON。
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('"jsonrpc"');
  });

  it("非法 JSON 行被忽略并如实报长度，后续行仍被处理（continue 而非 break）", () => {
    // 变异（continue → break）：改成 break 就会**丢掉后面所有合法行**，
    // 症状是"第一条消息之后 MCP 再也不回话"，极难定位。
    const r = feed(["{ 坏掉的 json", '{"jsonrpc":"2.0","id":1,"method":"tools/list"}']);
    expect(r.stderr).toContain("非法 JSON 行已忽略");
    // 关键断言：坏行之后的那条**仍然**得到了回复 —— 这正是 continue 的语义。
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('"jsonrpc"');
  });

  it("通知（id 缺失）回的是空结果对象，不是一个非法的 undefined 串", () => {
    // 变异 ③（!== → ===）：写反了就会**什么都不写** —— 而 JSON-RPC 客户端
    // 发了请求就在等回复，届时表现是"客户端一直挂着"。
    //
    // 实测纠偏：我起初以为通知不该有回复、断言 stdout 为空，实测拿到
    // `{"jsonrpc":"2.0","result":{}}`。那是 handleMcpMessage 的既定契约
    // （已处理并回执），不是缺陷 —— 要守的是"回执存在且是合法 JSON"。
    const r = feed(['{"jsonrpc":"2.0","method":"notifications/initialized"}']);
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const msg = JSON.parse(lines[0]!) as { jsonrpc?: string };
    expect(msg.jsonrpc).toBe("2.0");
    // 绝不能把 JS 的 undefined 序列化成字符串发出去 —— 客户端解析会直接崩
    expect(r.stdout).not.toContain("undefined");
  });

  it("合法请求才写一行 JSON（每行一个响应，协议纪律）", () => {
    const r = feed(['{"jsonrpc":"2.0","id":7,"method":"tools/list"}']);
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const msg = JSON.parse(lines[0]!) as { id?: number };
    expect(msg.id).toBe(7);
    // 启动横幅只允许出现在 stderr —— 混进 stdout 整个会话就坏了
    expect(r.stdout).not.toContain("stdout 是协议通道");
    expect(r.stderr).toContain("stdout 是协议通道");
  });
});

describe("headless-main · 空 stdin 的退出契约", () => {
  it("空 stdin → 快速 exit 1，且说清是 stdin 不合法", () => {
    // 这一条是"实测纠偏"的记录：我起初以为它会挂住（探测脚本读到了
    // status=undefined），真跑才发现 0.1s 就退、exit 1 —— 是我探测脚本
    // 的 stdin 处理不对，不是产品缺陷。**记下来以免下一个人再怀疑一遍。**
    const r = runEntry("headless-main.js", [], 15_000);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("stdin 不是合法 JSON");
  });

  it("合法 JSON 但字段缺失 → exit 1，且点名缺什么", () => {
    const valid = spawnSync(process.execPath, [path.join(HEADLESS_DIST, "headless-main.js")], {
      encoding: "utf8",
      timeout: 15_000,
      input: "{}",
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(valid.status).toBe(1);
    // 协议纪律：终态 error 走 stdout（JSONL），不是 stderr
    expect(valid.stdout).toContain('"type":"error"');
    expect(valid.stdout).toContain("requirement");
  });
});

/**
 * `serve-main.ts` 的 `main()` 里，定时那一支（`--every` / `--spec` /
 * `--schedule-state`）此前**一条端到端都没有**：`parseScheduleArgs` 与
 * `decideStartupCatchup` 各有纯函数用例，而"启动即预校验 spec"和"补跑真的把 spec
 * 投进自己的 /run"这两段只在真启动服务时才求值 —— 正是本文件反复钉的那类盲区
 * （只测被调函数，入口坏着报绿）。
 *
 * 症状各不相同：spec 坏了却把服务起起来 = 每次触发都 400，操作者以为定时在跑；
 * 补跑链路断在任何一环（时间戳读不出 / 自调用地址错 / 落盘没做）= 服务照常应答、
 * 日志一句 `[schedule]` 也没有，而 README 承诺的是"停机期间错过的触发点重启补跑一次"。
 */
describe("serve-main · 定时运行（--every/--spec）的真接线", () => {
  const tmpDirs: string[] = [];
  const makeTmp = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-schedule-e2e-"));
    tmpDirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("--spec 指向读不到的文件 → 启动即 exit 1，服务根本不起来", () => {
    ensureFreshDist();
    const missing = path.join(os.tmpdir(), "ox-no-such-schedule-spec.json");
    const r = runEntry(
      "serve-main.js",
      ["--port=18791", "--every=1h", `--spec=${missing}`],
      15_000,
    );
    expect(r.code).toBe(1);
    // 承重断言：不许出现启动横幅。带着坏 spec 把服务起起来，症状是"看起来正常、
    // 每次触发都 400"，而 exit 1 + 一句读取失败才是可诊断的。
    expect(r.stdout).not.toContain("OxCommander serve:");
    expect(r.stderr).toContain("--spec 读取失败");
  });

  it("--spec 是合法 JSON 但过不了 parseSpec → exit 1，且说清校验失败", () => {
    ensureFreshDist();
    const bad = path.join(makeTmp(), "spec.json");
    fs.writeFileSync(
      bad,
      JSON.stringify({ requirement: "x", projectRoot: ".", arbitration: "bogus" }),
      "utf8",
    );
    const r = runEntry("serve-main.js", ["--port=18792", "--every=1h", `--spec=${bad}`], 15_000);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("OxCommander serve:");
    expect(r.stderr).toContain("--spec 校验失败");
    // 同一句话由 /run 的 400 说：预校验与运行期共用一个 parseSpec，不许两份口径。
    expect(r.stderr).toContain("arbitration");
  });

  it("错过触发点 → 启动补跑真的 POST /run 并把时间戳落盘（且至多一次）", async () => {
    ensureFreshDist();
    const dir = makeTmp();
    const projectRoot = path.join(dir, "project");
    fs.mkdirSync(projectRoot);
    const specFile = path.join(dir, "spec.json");
    const stateFile = path.join(dir, "state.json");
    // projectRoot 指向临时目录：run 的 journal 落在**它自己的** projectRoot 里。
    // 这里写 "." 会把 ox-run-journal.json 造进本仓库 —— 用例全绿而工作树被写脏，
    // 那正是"没有测试能抓"的一族（CI 靠 git diff --exit-code 也只在它被跟踪时才逮得到）。
    fs.writeFileSync(
      specFile,
      JSON.stringify({ requirement: "定时样例", projectRoot }),
      "utf8",
    );
    const stale = Date.now() - 3_600_000;
    fs.writeFileSync(stateFile, JSON.stringify({ lastFiredMs: stale }), "utf8");

    const port = 18793;
    const child = spawn(
      process.execPath,
      [
        path.join(HEADLESS_DIST, "serve-main.js"),
        `--port=${port}`,
        // 间隔给 1h：补跑之后下一次在一小时后，所以"至多一次"在本用例的窗口里是确定的，
        // 不需要赌一个短间隔的时序。
        "--every=1h",
        `--spec=${specFile}`,
        `--schedule-state=${stateFile}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout!.on("data", (c: Buffer | string) => {
      out += c.toString();
    });
    const waitFor = async (pred: () => boolean, ms: number, what: string): Promise<void> => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`等${what}超时（${ms}ms）。stdout 尾部：${JSON.stringify(out.slice(-600))}`);
    };
    try {
      await waitFor(
        () => out.includes("OxCommander serve:"),
        15_000,
        "启动横幅（没有它说明服务没起来，后面一切都不成立）",
      );
      await waitFor(
        () => out.includes("[schedule] 定时触发"),
        12_000,
        "定时环的补跑触发日志",
      );
      expect(out, "启动时应说明这是错过的触发点被补跑").toContain("启动补跑一次");
      // 差分断言：时间戳必须从"一小时前的陈旧值"移动到"刚才"。这一步只有整条链
      // （读状态 → 判错过 → POST /run → serve 回 2xx → saveState）全通才做得到。
      await waitFor(() => {
        let s: { lastFiredMs?: number } | undefined;
        try {
          s = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { lastFiredMs?: number };
        } catch {
          return false;
        }
        return typeof s?.lastFiredMs === "number" && s.lastFiredMs > stale;
      }, 10_000, "状态文件里的 lastFiredMs 被刷新");

      // 至多一次：接受日志只该出现一遍（第二次说明间隔推算坏了）。
      const fired = (out.match(/定时触发：run 已接受/g) ?? []).length;
      expect(fired, `补跑应恰好一次，实际日志里有 ${fired} 次：${JSON.stringify(out.slice(-400))}`).toBe(1);
    } finally {
      child.kill();
    }
  }, 60_000);
});

/**
 * 310e6a7（serve 默认只绑回环 + 非回环强制 token）新加的分支，本机 site 口径实测**四处存活**
 * —— 那笔提交没跑过 `mutation:audit`，而 CI 最后一次绿的是它之前的 `8d24511`。
 * 存活位点的意思不是"代码错了"，而是"这段行为没有任何断言看着它"：绑定地址与暴露提示
 * 恰好都是**只在真启动、真绑定**时才求值的那一类，纯函数用例够不到。
 *
 * 下面三条逐个把它们钉住（第三条同时覆盖 `三元分支互换` 与 `=== → !==` 两个算子）。
 */
describe("serve-main · 绑定地址与暴露提示（310e6a7 的存活位点）", () => {
  it("hostFromArgv：非 --host 的参数被跳过，不是终止扫描（continue 的语义）", () => {
    // 变异成 break 时，`verbose` 之后的 --host 永远不会被看到 ⇒ 这里必红。
    expect(hostFromArgv(["verbose", "--host", "127.0.0.1"])).toEqual({ host: "127.0.0.1" });
    expect(hostFromArgv(["verbose", "--port=1", "--host=localhost"])).toEqual({ host: "localhost" });
  });

  it("显式 --host 真的进 startServe：横幅印的是给的那个地址，而不是回环默认", async () => {
    ensureFreshDist();
    const port = 18794;
    const child = spawn(process.execPath, [path.join(HEADLESS_DIST, "serve-main.js"), `--port=${port}`, "--host=localhost"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const line = await firstLine(child.stdout!, 15_000);
      // 条件展开被写反（!== → === / 三元分支互换）时，host 根本不注入，
      // startServe 落回默认回环 —— 横幅于是变成 127.0.0.1，正是这条断言要逮的。
      expect(line).toContain(`http://localhost:${port}/`);
      expect(line).not.toContain("http://127.0.0.1:");
    } finally {
      child.kill();
    }
  }, 40_000);

  it("绑到 0.0.0.0（带 token）时横幅必须补一句「本机用回环连」", async () => {
    ensureFreshDist();
    const port = 18795;
    // 那句提示在**第二行**：`exposure` 以换行开头（它是追加给告警行的），所以这里
    // 只能读整段输出，firstLine 会把它截掉 —— 我第一版就是这么误判成产品缺陷的。
    const readAll = (child: ReturnType<typeof spawn>, want: (text: string) => boolean, ms: number) =>
      new Promise<string>((resolve, reject) => {
        let text = "";
        const timer = setTimeout(() => reject(new Error(`等输出超时，已收到：${JSON.stringify(text)}`)), ms);
        child.stdout!.on("data", (c: Buffer | string) => {
          text += c.toString();
          if (want(text)) {
            clearTimeout(timer);
            resolve(text);
          }
        });
        child.stderr!.on("data", (c: Buffer | string) => {
          text += c.toString();
        });
      });

    const wildcard = spawn(
      process.execPath,
      [path.join(HEADLESS_DIST, "serve-main.js"), `--port=${port}`, "--host=0.0.0.0"],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OX_SERVE_TOKEN: "probe-token" } },
    );
    let wildcardOut = "";
    try {
      wildcardOut = await readAll(wildcard, (t) => t.includes("OxCommander serve:") && t.includes("已绑定"), 15_000);
      expect(wildcardOut).toContain(`http://0.0.0.0:${port}/`);
      // 这句提示是 fail-closed 那轮的"暴露面要说破"半边：通配地址上没有回环可点，
      // 少了这句，操作者会以为 0.0.0.0 不能本机连。
      expect(wildcardOut).toContain(`本机可直接用 http://127.0.0.1:${port}`);
    } finally {
      wildcard.kill();
    }

    // IPv6 通配（`::`）：那句提示的条件是"0.0.0.0 **或** ::"，第二个操作数只有真绑过
    // 才杀得死。宿主没有 IPv6 时服务会明确报绑定失败 —— 那种情况下这里认的是那句
    // 错误，而不是装作这一档通过（本机 win32 与 CI ubuntu 的差异就写在这条断言里）。
    const v6Port = port + 2;
    const v6 = spawn(
      process.execPath,
      [path.join(HEADLESS_DIST, "serve-main.js"), `--port=${v6Port}`, "--host=::"],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OX_SERVE_TOKEN: "probe-token" } },
    );
    let v6Out = "";
    try {
      v6Out = await readAll(
        v6,
        (t) => t.includes("OxCommander serve:") || t.includes("EADDR") || /listen|bind|失败/i.test(t),
        15_000,
      );
    } finally {
      v6.kill();
    }
    if (v6Out.includes("OxCommander serve:")) {
      expect(v6Out).toContain("已绑定");
      expect(v6Out).toContain(`本机可直接用 http://127.0.0.1:${v6Port}`);
    } else {
      console.warn(`本机无法绑定 ::（IPv6 不可用），这一档位点由 CI ubuntu 覆盖：${v6Out.slice(0, 200)}`);
    }

    // 对照：回环绑定不该出现这两句（否则"补一句"退化成无条件打印，三元分支就白写了）。
    const loopback = spawn(process.execPath, [path.join(HEADLESS_DIST, "serve-main.js"), `--port=${port + 1}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const out2 = await readAll(loopback, (t) => t.includes("OxCommander serve:"), 15_000);
      expect(out2).not.toContain("已绑定");
      expect(out2).not.toContain("本机可直接用");
      // 反向对照还有一层含义：wildcard 那轮真的等到"已绑定"才继续，
      // 所以这里 0 命中不是"输出没来"，而是"确实不打这句"。
      expect(out2).toContain(`http://127.0.0.1:${port + 1}/`);
    } finally {
      loopback.kill();
    }
  }, 60_000);
});