import { URL } from "node:url";

/**
 * 远程执行器的边界判定（纯逻辑）。
 *
 * 背景：`http-bridge` 适配器本来就支持任意 `baseUrl` —— **它已经是一个远程执行器**
 * （把 baseUrl 指到另一台机器上的桥接服务即可，协议见 `agents.d/README.md`）。
 * 所以这一格缺的从来不是"能不能连"，而是**没人说破代价**：
 *
 *   远端执行器写的是远端的文件系统，本地的 `FileJournal` / `BatchGuard` 看不见
 *   任何变化 ⇒ zone 越权检测、冲突仲裁、快照回滚对它**全部静默失效**。
 *   表现不是报错，而是"这批改动看起来干干净净"—— 比报错危险得多。
 *
 * 因此这里不做拦截（远程执行是正当需求，Orca 那类工具用 SSH worktree 做同样的事），
 * 只做一件事：把边界说出来，让操作者知道这一路的担保降到了哪一档。
 */

/** 回环地址：本机起的桥接服务（本地 GUI 智能体就是这种）。 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "::"]);

/**
 * `baseUrl` 是否指向本机。
 *
 * 判定**故意保守**：只在明确是回环名/回环地址时判 true。解析不出来（非法 URL）、
 * 或者指向局域网 IP / 域名，一律按"不在本机"处理 —— 因为无法证明它在本机，
 * 而漏报（把远端当本机）会让"本地沙箱兜底"这句担保变成假的。
 */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    // 127.0.0.0/8 整段都是回环，逐个列举列不完。
    if (/^127\./.test(host)) return true;
    return LOOPBACK_HOSTS.has(host) || LOOPBACK_HOSTS.has(url.host.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * 远端执行器的边界说明。
 *
 * 只在**确实不是本机**时返回一句话；本机的桥接（Marvis 那一类）不该被泼冷水 ——
 * 它们的改动落在本地工作区，沙箱与仲裁照常生效。
 */
export function remoteExecutorNote(id: string, baseUrl: string): string | undefined {
  if (isLoopbackBaseUrl(baseUrl)) return undefined;
  return (
    `智能体「${id}」的桥接地址不在本机（${baseUrl}）：它改的是远端的文件，` +
    `本地的 zone 越权检测、冲突仲裁与快照回滚对它**都不生效**（不是报错，是看不见）。` +
    `远端侧的隔离与回滚要由它自己负责`
  );
}
