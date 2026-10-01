import fs from "node:fs";
import path from "node:path";
import { mergePolicies, normalizePolicyFile, type PolicyFile } from "../../shared/policy-file";

/**
 * `policy.d/` —— 策略即代码的目录加载（IO 层）。
 *
 * 规则刻意与 `agents.d/` 同构（同一套心智，不必学两次）：
 *   · 只读 `*.json`，跳过 `*.example.json`；
 *   · 一个文件可以是对象或数组（一次声明多份策略）；
 *   · **单个文件坏只记录并跳过**，不影响其它策略，也不让 run 起不来。
 *
 * 差别在一处：策略是安全边界，所以未知版本整份丢弃（`normalizePolicyFile`
 * 里就做了），而不是"尽量理解"。
 */
export interface PolicyLoadError {
  file: string;
  issues: string[];
}

export interface LoadedPolicies {
  /** 合成后的策略（多份取并集、预算取最小）。 */
  policy: PolicyFile;
  /** 逐文件的问题清单；空数组 = 目录干净或不存在。 */
  errors: PolicyLoadError[];
  /** 实际生效的策略文件数（坏的不算）。 */
  files: number;
}

const EMPTY: LoadedPolicies = { policy: { version: 1 }, errors: [], files: 0 };

export function loadPolicyDir(dir: string | undefined): LoadedPolicies {
  if (!dir) return EMPTY;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".example.json"));
  } catch {
    // 目录不存在不是错误：没写策略就是"用内置规则"，不该因此启动失败。
    return EMPTY;
  }
  const policies: PolicyFile[] = [];
  const errors: PolicyLoadError[] = [];
  for (const name of entries.sort()) {
    const file = path.join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      errors.push({ file, issues: [`JSON 解析失败：${(err as Error).message}`] });
      continue;
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const [i, raw] of list.entries()) {
      const { policy, issues } = normalizePolicyFile(raw);
      if (issues.length > 0) errors.push({ file: `${file}[${i}]`, issues });
      // 解析不出任何有效规则的文件不算"生效" —— 但它的问题已经记下了。
      if (issues.length === 0) policies.push(policy);
    }
  }
  return { policy: mergePolicies(policies), errors, files: policies.length };
}
