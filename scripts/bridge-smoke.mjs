// 冒烟：dsh-oxcommander 插件 → headless runner 桥接验证（无需真实 LLM 调用）。
// 用假 key 通过插件密钥前置检查；project_root 指向不存在目录，让 runner 立即
// 返回结构化 error 事件（exit 1）——足以验证 spawn / JSONL 解析 / 终态汇总整条链路。
// 用法：node scripts/bridge-smoke.mjs
process.env.SENSENOVA_API_KEY = process.env.SENSENOVA_API_KEY || 'sk-fake-smoke'
process.env.OXCOMMANDER_HOME = process.env.OXCOMMANDER_HOME || 'D:/ox/ox-commander'

const plugin = await import('file:///D:/deep/dsh-oxcommander/lib/index.mjs')

const registered = []
const ctx = { tools: { register: (t) => registered.push(t) } }
await plugin.apply(ctx)

const names = registered.map((t) => t.name)
console.log('registered tools:', names.join(', '))
if (names.length !== 4) throw new Error(`expected 4 tools, got ${names.length}`)

const run = registered.find((t) => t.name === 'oxcommander_run')
const res = await run.execute({
  requirement: 'bridge smoke',
  project_root: 'D:/ox/.smoke-bad-root-does-not-exist',
})
console.log('run result:', JSON.stringify(res, null, 2))
if (res.exit_code !== 1) throw new Error(`expected exit_code 1, got ${res.exit_code}`)
if (!res.summary.includes('projectRoot')) throw new Error('expected structured error mentioning projectRoot')
console.log('BRIDGE SMOKE OK')
