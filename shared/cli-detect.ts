/**
 * 执行器自动探测（竞品缺口 C6）的**纯**部分：PATH 解析与候选判定。
 *
 * 为什么必须纯：判定逻辑要在单测里跑"装了 / 没装 / PATH 为空 / 目录不可读"
 * 这几种形态，真机器上造不出来（尤其"PATH 里有个不存在的目录"）。读盘与
 * 进程环境那薄薄一层留在 `electron/agents/cli-detect.ts`。
 *
 * 两条纪律：
 *
 * 1. **不 spawn**。探测只是"PATH 里有没有这个文件"，不需要跑命令 ——
 *    跑 `<cmd> --version` 既慢（几十毫秒 × N 个）、又会让用户的 CLI 在
 *    不知情时被叫起来一次（有的 CLI 首次运行会触发登录流）。
 * 2. **缺席是结果，不是错误**。没装就说没装，并给出安装提示；
 *    没装的东西不进候选，也不假装可以接入。
 */

/** 一个可执行器候选（模板来源见 `electron/agents/cli-detect.ts`）。 */
export interface CliCandidate {
  id: string;
  displayName: string;
  /** 在 PATH 里要找的命令名（claude / codex / aider …）。 */
  command: string;
  /** 找不到时给人看的安装提示（必须是核实过的命令，见源文件的注释）。 */
  installHint: string;
  /** 可直接注册的 manifest（接入按钮把它交给 `agents:register`）。 */
  manifest: Record<string, unknown>;
}

/** 探测结果：人在界面上要看的全部事实。 */
export interface DetectedCli {
  id: string;
  displayName: string;
  command: string;
  /** 在 PATH 里是否找到了。 */
  found: boolean;
  /** 找到的绝对路径（未找到时缺席，不是空串）。 */
  absPath?: string;
  installHint: string;
  /** 是否已经在池里（已注册的不再显示"接入"）。 */
  registered: boolean;
  manifest: Record<string, unknown>;
}

/** Windows 上 npm 全局装出来的 shim 形态（无扩展 + .cmd/.bat/.exe）。 */
const WIN_EXTENSIONS = ["", ".cmd", ".bat", ".exe"];

/**
 * 把 PATH 环境变量切成目录列表。
 *
 * `isWindows` **必须由调用方给**，不从字符串里猜：Windows 的段里带着驱动号
 * 的冒号（`C:\bin`），而 POSIX 的分隔符正是冒号 —— 靠"里面有没有分号"去猜
 * 平台，会在 Windows 上把每个路径切成两半（实测：`C:\Users\…\ox-detect-x`
 * 变成 `"C"` + `"\Users\…"`），于是什么都扫不到。
 *
 * 空段被过滤（空串会被 `path.join` 当成"当前目录"，那是 PATH 的真实语义之一，
 * 既不悄悄抹掉也不悄悄加进去）。
 *
 * 不存在的目录**保留**由 resolve 阶段去问 exists —— 扫 PATH 时目录不存在是常态。
 */
export function splitPathEnv(pathEnv: string, isWindows: boolean): string[] {
  if (pathEnv === "") return [];
  const sep = isWindows ? ";" : ":";
  return pathEnv.split(sep).filter((p) => p !== "");
}

/**
 * 在给定的 PATH 目录里找命令；找到返回绝对路径，找不到返回 `null`。
 *
 * `exists` 由调用方注入（真盘上是 `fs.existsSync`，测试里是内存集合）——
 * 这是"纯"的关键：本函数不做任何 IO。
 */
export function resolveOnPath(
  command: string,
  dirs: readonly string[],
  exists: (abs: string) => boolean,
  isWindows: boolean,
): string | null {
  if (command === "") return null;
  // 命令里带分隔符时不查 PATH（那是路径，不是命令）—— 否则
  // "C:/evil/claude" 会被当成命令名去拼目录。
  if (command.includes("/") || command.includes("\\")) return null;
  const names = isWindows ? WIN_EXTENSIONS.map((ext) => `${command}${ext}`) : [command];
  for (const dir of dirs) {
    for (const name of names) {
      // 一律用正斜杠拼，不做"目录尾部是否已有分隔符"的判断：那个判断的
      // 两支在两岸的 fs 上都指向同一个文件（`/` 与 `//` 等价、Windows 上
      // `C:\x` 与 `C:\/x` 等价），于是它在变异门禁里是永久存活的假位点。
      // 按「能简化就简化」处理：多余的分隔符由 fs 自己吸收。
      const abs = `${dir}/${name}`;
      if (exists(abs)) return abs;
    }
  }
  return null;
}
