#!/usr/bin/env node
// mneme.mjs — 查詢接口（info / matrix / recall / search / read），零依賴，Node 22+
//
//   node reference/mneme.mjs info   --root "D:\記憶庫"
//   node reference/mneme.mjs recall --root "D:\記憶庫" --as owner
//   node reference/mneme.mjs search --root "D:\記憶庫" --as alpha "關鍵字"
//   node reference/mneme.mjs read   --root "D:\記憶庫" --as alpha "diary/2026-11-20.md"
//
// 涉及資料的指令一律必須帶 --as <角色>；缺少時以退出碼 2 拒絕執行（不會默默當 owner）。

import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import {
  MIXED, canRead, describe, isInsideReal, loadConfig, matrix, readableScopes, realRoot, resolveInside, scopeOf, visibilityOf
} from './acl.mjs'

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.jsonl', '.csv', '.yaml', '.yml'])
const SKIP_DIRS = new Set(['_drafts', '_audit', 'node_modules', '.git'])
const DENY = '找不到檔案，或你無權讀取。'

const USAGE = `用法：
  mneme.mjs info   --root <記憶庫路徑>
  mneme.mjs matrix --root <記憶庫路徑>
  mneme.mjs recall --root <記憶庫路徑> --as <角色>
  mneme.mjs search --root <記憶庫路徑> --as <角色> [--scope <分區>] [--limit N] <關鍵字...>
  mneme.mjs read   --root <記憶庫路徑> --as <角色> <相對路徑>

角色必須由屋主指定，沒有預設值。info / matrix 不需要角色。`

class UsageError extends Error {
  constructor(message) {
    super(message)
    this.code = 'USAGE'
  }
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) args[key] = true
      else {
        args[key] = next
        i++
      }
    } else args._.push(token)
  }
  if (args.as === true) throw new UsageError('--as 後面要接角色名稱')
  return args
}

function requireRoot(args) {
  if (typeof args.root !== 'string') throw new UsageError('缺少 --root <記憶庫路徑>')
  return resolve(args.root)
}

// 角色沒有預設值：沒帶就拒絕（退出碼 2），不會退回 owner。
// 角色可選擇性地在 mneme.json 用 aliases 宣告別名（例如舊名、暱稱），這裡會解析成正式名稱。
function resolveRoleName(config, value) {
  const roles = config.roles ?? {}
  if (Object.hasOwn(roles, value)) return value
  for (const [name, role] of Object.entries(roles)) {
    const aliases = Array.isArray(role?.aliases) ? role.aliases : []
    if (aliases.includes(value)) return name
  }
  return null
}

function requireRole(config, args) {
  const canonical = Object.keys(config.roles ?? {}).join('、')
  if (typeof args.as !== 'string') {
    throw new UsageError(`這個指令必須指定 --as <角色>（可用：${canonical}）`)
  }
  const resolved = resolveRoleName(config, args.as)
  if (!resolved) {
    throw new UsageError(`未知角色：${args.as}（可用：${canonical}）`)
  }
  return resolved
}

// 走訪檔案；目錄與檔案都要通過真實路徑檢查，擋掉符號連結／junction 逃逸。
function walk(root, dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      let real
      try {
        real = realpathSync(full)
      } catch {
        continue
      }
      if (!isInsideReal(root, real)) continue
      walk(root, full, out)
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf('.'))
      if (!TEXT_EXT.has(ext)) continue
      let real
      try {
        real = realpathSync(full)
      } catch {
        continue
      }
      if (!isInsideReal(root, real)) continue
      out.push(real) // 存真實路徑，避免檢查與讀取之間的 TOCTOU
    }
  }
  return out
}

const norm = text => String(text).normalize('NFKC').toLowerCase()

function firstHeading(text) {
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#')) return line.replace(/^#+\s*/, '').trim()
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) return line.trim().slice(0, 80)
  }
  return ''
}

function relOf(base, file) {
  return relative(base, file).split('\\').join('/')
}

function cmdRecall(config, root, role, scopeFilter = null) {
  // 一律以真實路徑為基準：記憶庫本身可能是 junction／symlink（Windows 很常見）
  const base = realRoot(root)
  const readable = readableScopes(config, role)
  if (scopeFilter) {
    if (!Object.hasOwn(config.scopes ?? {}, scopeFilter)) {
      throw new UsageError(`未註冊的分區：${scopeFilter}（可用：${Object.keys(config.scopes ?? {}).join('、')}）`)
    }
    if (!readable.includes(scopeFilter)) throw new Error(`角色 ${role} 不能讀分區 ${scopeFilter}`)
  }
  const scopes = scopeFilter ? [scopeFilter] : readable
  const files = []
  for (const scope of scopes) {
    for (const file of walk(base, join(base, scope))) {
      const rel = relOf(base, file)
      const text = readFileSync(file, 'utf8')
      files.push({
        path: rel,
        scope,
        visibility: visibilityOf(config, rel),
        layer: config.scopes[scope]?.layer ?? 'L2',
        budgetKB: config.scopes[scope]?.budgetKB ?? null,
        bytes: Buffer.byteLength(text),
        firstHeading: firstHeading(text)
      })
    }
  }
  const order = { L0: 0, L1: 1, L2: 2 }
  files.sort((a, b) => (order[a.layer] ?? 9) - (order[b.layer] ?? 9) || a.path.localeCompare(b.path))

  const used = new Map()
  for (const file of files) {
    if (file.budgetKB == null) continue
    const spent = used.get(file.scope) ?? 0
    file.overBudget = spent + file.bytes > file.budgetKB * 1024
    used.set(file.scope, spent + file.bytes)
  }
  return { role, scopes, count: files.length, files }
}

function cmdSearch(config, root, role, keywords, options) {
  const terms = keywords.map(word => word.trim()).map(norm).filter(Boolean)
  if (!terms.length) throw new UsageError('請提供至少一個非空白關鍵字')

  const allowed = readableScopes(config, role)
  const scopeFilter = typeof options.scope === 'string' ? options.scope : null
  if (scopeFilter) {
    if (!Object.hasOwn(config.scopes ?? {}, scopeFilter)) {
      throw new UsageError(`未註冊的分區：${scopeFilter}（可用：${Object.keys(config.scopes ?? {}).join('、')}）`)
    }
    if (!allowed.includes(scopeFilter)) {
      throw new Error(`角色 ${role} 不能讀分區 ${scopeFilter}`)
    }
  }

  const base = realRoot(root)
  const limitRaw = options.limit ?? 50
  const limit = Number(limitRaw)
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError(`--limit 必須是正整數：${limitRaw}`)

  const results = []
  for (const scope of allowed) {
    if (scopeFilter && scope !== scopeFilter) continue
    for (const file of walk(base, join(base, scope))) {
      const rel = relOf(base, file)
      const visibility = visibilityOf(config, rel)
      if (!canRead(config, role, visibility)) continue
      const text = readFileSync(file, 'utf8')
      const haystack = norm(text)
      if (!terms.every(term => haystack.includes(term))) continue

      // 只把「全部關鍵字都命中的那一行」當證據
      const lines = text.split(/\r?\n/)
      const index = lines.findIndex(line => terms.every(term => norm(line).includes(term)))
      results.push({
        path: rel,
        scope,
        visibility,
        line: index + 1,
        snippet: index >= 0 ? lines[index].trim().slice(0, 160) : ''
      })
      if (results.length >= limit) {
        return { role, keywords, count: results.length, limitReached: true, results }
      }
    }
  }
  return { role, keywords, count: results.length, limitReached: false, results }
}

function cmdRead(config, root, role, target) {
  let rel
  try {
    rel = resolveInside(root, target)
  } catch {
    throw new Error(DENY) // 越界、不存在、指向外面：同一個訊息
  }
  const relPath = relative(realRoot(root), rel).split('\\').join('/')
  const visibility = visibilityOf(config, relPath)
  if (!canRead(config, role, visibility)) throw new Error(DENY)

  let text
  try {
    text = readFileSync(rel, 'utf8')
  } catch {
    throw new Error(DENY)
  }
  return { path: relPath, scope: scopeOf(relPath), visibility, bytes: Buffer.byteLength(text), content: text }
}

function print(value) {
  console.log(JSON.stringify(value, null, 2))
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`✗ ${error.message}`)
    console.error(USAGE)
    process.exitCode = 2
    return
  }

  const command = args._[0]
  if (!command || command === 'help') {
    console.log(USAGE)
    return
  }

  try {
    const root = requireRoot(args)
    const config = loadConfig(root)

    if (command === 'info') return print(describe(config))
    if (command === 'matrix') return print(matrix(config))

    const role = requireRole(config, args)
    if (command === 'recall') return print(cmdRecall(config, root, role, args.scope === true ? null : args.scope ?? null))
    if (command === 'search') return print(cmdSearch(config, root, role, args._.slice(1), args))
    if (command === 'read') {
      if (!args._[1]) throw new UsageError('請提供相對路徑')
      return print(cmdRead(config, root, role, args._[1]))
    }
    throw new UsageError(`未知指令：${command}`)
  } catch (error) {
    if (error.code === 'USAGE') {
      console.error(`✗ ${error.message}`)
      console.error(USAGE)
      process.exitCode = 2
    } else {
      console.error(`✗ ${error.message}`)
      process.exitCode = 1
    }
  }
}

main()
