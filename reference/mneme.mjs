#!/usr/bin/env node
// mneme.mjs — 查詢接口（info / recall / search / read），零依賴，Node 22+
//
//   node reference/mneme.mjs info   --root "D:\記憶庫"
//   node reference/mneme.mjs recall --root "D:\記憶庫" --as owner
//   node reference/mneme.mjs search --root "D:\記憶庫" --as alpha "關鍵字"
//   node reference/mneme.mjs read   --root "D:\記憶庫" --as alpha "diary/2026-11-20.md"

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  MIXED, canRead, describe, loadConfig, matrix, readableScopes, safeRel, visibilityOf
} from './acl.mjs'

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.jsonl', '.csv', '.yaml', '.yml'])
const SKIP_DIRS = new Set(['_drafts', '_audit', 'node_modules', '.git'])

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) args[key] = true
      else { args[key] = next; i++ }
    } else {
      args._.push(token)
    }
  }
  return args
}

function requireRoot(args) {
  if (typeof args.root !== 'string') throw new Error('缺少 --root <記憶庫路徑>')
  return resolve(args.root)
}

function requireRole(config, args) {
  const explicit = typeof args.as === 'string'
  const role = explicit ? args.as : 'owner'
  if (!config.roles?.[role]) {
    throw new Error(`未知角色：${role}（可用：${Object.keys(config.roles ?? {}).join('、')}）`)
  }
  // 未指定 --as 時不默默當屋主：協定要求身分必須被明確指定
  if (!explicit) {
    console.error('⚠ 未指定 --as <角色>，本次以 owner 執行。角色應該由屋主指定，不是預設值。')
  }
  return role
}

function walk(dir, base = dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(join(dir, entry.name), base, out)
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf('.'))
      if (TEXT_EXT.has(ext)) out.push(join(dir, entry.name))
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

function cmdInfo(config, root) {
  return describe(config)
}

function cmdRecall(config, root, role) {
  const scopes = readableScopes(config, role)
  const files = []
  for (const scope of scopes) {
    const dir = join(root, scope)
    for (const file of walk(dir)) {
      const bytes = statSync(file).size
      const text = readFileSync(file, 'utf8')
      files.push({
        path: file.slice(root.length + 1).replaceAll('\\', '/'),
        scope,
        visibility: visibilityOf(config, file.slice(root.length + 1)),
        layer: config.scopes[scope]?.layer ?? 'L2',
        budgetKB: config.scopes[scope]?.budgetKB ?? null,
        bytes,
        firstHeading: firstHeading(text)
      })
    }
  }
  const order = { L0: 0, L1: 1, L2: 2 }
  files.sort((a, b) => (order[a.layer] ?? 9) - (order[b.layer] ?? 9) || a.path.localeCompare(b.path))

  // 只回清單與標題，不回全文；超預算只標記，不自動截斷（交給呼叫端決定）
  const seen = new Map()
  for (const file of files) {
    if (file.budgetKB == null) continue
    const used = seen.get(file.scope) ?? 0
    file.truncated = used + file.bytes > file.budgetKB * 1024
    seen.set(file.scope, used + file.bytes)
  }
  return { role, scopes, count: files.length, files }
}

function cmdSearch(config, root, role, keywords, options) {
  const terms = keywords.map(norm).filter(Boolean)
  if (!terms.length) throw new Error('請提供至少一個關鍵字')
  const allowed = readableScopes(config, role)
  const scopeFilter = typeof options.scope === 'string' ? options.scope : null
  if (scopeFilter && !allowed.includes(scopeFilter)) {
    throw new Error(`角色 ${role} 不能讀分區 ${scopeFilter}`)
  }
  const limit = Number(options.limit ?? 50)
  const results = []

  for (const scope of allowed) {
    if (scopeFilter && scope !== scopeFilter) continue
    for (const file of walk(join(root, scope))) {
      const rel = file.slice(root.length + 1).replaceAll('\\', '/')
      const visibility = visibilityOf(config, rel)
      if (!canRead(config, role, visibility)) continue
      const text = readFileSync(file, 'utf8')
      const haystack = norm(text)
      if (!terms.every(term => haystack.includes(term))) continue
      const lines = text.split(/\r?\n/)
      const lineIndex = lines.findIndex(line => norm(line).includes(terms[0]))
      results.push({
        path: rel,
        scope,
        visibility,
        line: lineIndex + 1,
        snippet: (lines[lineIndex] ?? '').trim().slice(0, 160)
      })
      if (results.length >= limit) return { role, keywords, count: results.length, truncated: true, results }
    }
  }
  return { role, keywords, count: results.length, truncated: false, results }
}

function cmdRead(config, root, role, target) {
  const rel = safeRel(root, target)
  const visibility = visibilityOf(config, rel)
  // 無權限與不存在回同一個錯誤，不洩漏存在性
  const deny = () => { throw new Error('找不到檔案，或你無權讀取。') }
  if (!canRead(config, role, visibility)) deny()
  let text
  try {
    const abs = resolve(root, rel)
    if (!statSync(abs).isFile()) deny()
    text = readFileSync(abs, 'utf8')
  } catch {
    deny()
  }
  return { path: rel, scope: rel.split('/')[0], visibility, bytes: Buffer.byteLength(text), content: text }
}

function print(value, json) {
  if (json) return console.log(JSON.stringify(value, null, 2))
  if (Array.isArray(value)) return console.log(value.map(v => JSON.stringify(v)).join('\n'))
  console.log(JSON.stringify(value, null, 2))
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  const json = Boolean(args.json)

  try {
    if (!command || command === 'help') {
      console.log(readFileSync(new URL('./mneme.mjs', import.meta.url), 'utf8')
        .split('\n').slice(1, 9).join('\n').replace(/^\/\/ ?/gm, ''))
      return
    }
    const root = requireRoot(args)
    const config = loadConfig(root)
    const role = requireRole(config, args)

    if (command === 'info') return print(cmdInfo(config, root), true)
    if (command === 'matrix') return print(matrix(config), true)
    if (command === 'recall') return print(cmdRecall(config, root, role), true)
    if (command === 'search') return print(cmdSearch(config, root, role, args._.slice(1), args), true)
    if (command === 'read') {
      if (!args._[1]) throw new Error('請提供相對路徑')
      return print(cmdRead(config, root, role, args._[1]), true)
    }
    throw new Error(`未知指令：${command}`)
  } catch (error) {
    console.error(`✗ ${error.message}`)
    process.exitCode = 1
  }
}

main()
