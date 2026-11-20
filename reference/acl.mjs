// acl.mjs — Mneme Protocol 權限判定（零依賴）
//
// 規則（見 SPEC.md 第 3～4 節）：
//   1. 歸屬只看分區（第一段目錄），不看內文。
//   2. 未註冊的分區一律視為 mixed，只有 owner 可讀。
//   3. 判定在「取資料之前」，不是撈完再過濾。
//   4. 無權限與不存在回傳相同結果。

import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const MIXED = 'mixed'
export const INTERNAL_PREFIXES = ['_drafts', '_audit']

export function toPosix(p) {
  return String(p).split(sep).join('/')
}

export function loadConfig(root) {
  const file = resolve(root, 'mneme.json')
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`找不到 mneme.json：${file}`)
  }
  let config
  try {
    config = JSON.parse(raw)
  } catch (error) {
    throw new Error(`mneme.json 不是合法 JSON：${error.message}`)
  }
  if (config.version !== 1) throw new Error(`不支援的 version=${config.version}（本實作只支援 1）`)
  if (!config.scopes || typeof config.scopes !== 'object') throw new Error('mneme.json 缺少 scopes')
  if (!config.roles || typeof config.roles !== 'object') throw new Error('mneme.json 缺少 roles')
  const owner = config.roles.owner
  if (!owner) throw new Error('mneme.json 必須定義 owner 角色')
  if (!Array.isArray(owner.read) || !owner.read.includes('*')) {
    throw new Error('owner 的 read 必須包含 "*"')
  }
  // 兩段式回寫不可關閉：讀到 false 就是無效設定
  if (config.writeback?.requireConfirm === false) {
    throw new Error('writeback.requireConfirm 不可設為 false（兩段式回寫不得關閉）')
  }
  return config
}

// 把使用者輸入的相對路徑收斂到記憶庫內部；越界就丟錯。
// 跨平台：Windows 風格的磁碟路徑在 POSIX 上不是絕對路徑，也要擋。
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/

export function safeRel(root, input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('路徑不可為空')
  if (isAbsolute(input) || WINDOWS_ABSOLUTE.test(input)) throw new Error('路徑必須是相對路徑')
  // Windows ADS（file.md::$DATA）與 NUL 都不得穿過
  if (input.includes(':') || input.includes('\0')) throw new Error('路徑含有不允許的字元')
  const base = resolve(root)
  const abs = resolve(base, input)
  const rel = relative(base, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('路徑超出記憶庫範圍')
  return toPosix(rel)
}

export function realRoot(root) {
  try {
    return realpathSync(resolve(root))
  } catch {
    return resolve(root)
  }
}

// 真實路徑是否仍在記憶庫內（擋符號連結／junction 逃逸）
export function isInsideReal(root, absPath) {
  const base = realRoot(root)
  const back = relative(base, absPath)
  return back === '' || (!back.startsWith('..') && !isAbsolute(back))
}

// 把相對路徑解析成真實的絕對路徑；越界、不存在、指向外面一律同一個錯誤。
export function resolveInside(root, relPath) {
  const rel = safeRel(root, relPath)
  const abs = resolve(realRoot(root), rel)
  let real
  try {
    real = realpathSync(abs)
  } catch {
    throw new Error('找不到檔案，或你無權讀取。')
  }
  if (!isInsideReal(root, real)) throw new Error('找不到檔案，或你無權讀取。')
  return real
}

export function scopeOf(relPath) {
  const parts = toPosix(relPath).split('/')
  // 根目錄的檔案（例如 mneme.json）不屬於任何分區 → 視為 mixed
  if (parts.length < 2) return null
  const first = parts[0]
  if (INTERNAL_PREFIXES.includes(first)) return null
  return first
}

export function visibilityOf(config, relPath) {
  const scope = scopeOf(relPath)
  if (!scope) return MIXED
  return config.scopes?.[scope]?.visibility ?? MIXED
}

export function roleOf(config, role) {
  // 用 hasOwn：避免 constructor / __proto__ / toString 走原型鏈「通過」檢查
  if (typeof role !== 'string' || !Object.hasOwn(config.roles ?? {}, role)) {
    const known = Object.keys(config.roles ?? {}).join('、')
    throw new Error(`未知角色：${role}（可用：${known}）`)
  }
  return config.roles[role]
}

export function canRead(config, role, visibility) {
  const list = roleOf(config, role).read ?? []
  return list.includes('*') || list.includes(visibility)
}

export function canWrite(config, role, scope) {
  const list = roleOf(config, role).write ?? []
  return list.includes('*') || list.includes(scope)
}

export function readableScopes(config, role) {
  return Object.entries(config.scopes ?? {})
    .filter(([, scope]) => canRead(config, role, scope.visibility ?? MIXED))
    .map(([name]) => name)
}

export function writableScopes(config, role) {
  return Object.keys(config.scopes ?? {}).filter(name => canWrite(config, role, name))
}

export function describe(config) {
  return {
    version: config.version,
    name: config.name ?? null,
    scopes: Object.entries(config.scopes ?? {}).map(([name, scope]) => ({
      name,
      visibility: scope.visibility ?? MIXED,
      layer: scope.layer ?? 'L2',
      budgetKB: scope.budgetKB ?? null,
      note: scope.note ?? null
    })),
    roles: Object.entries(config.roles ?? {}).map(([name, role]) => ({
      name,
      read: role.read ?? [],
      write: role.write ?? []
    })),
    writeback: config.writeback ?? {}
  }
}

// 給測試與文件用的矩陣
export function matrix(config) {
  const scopes = Object.keys(config.scopes ?? {})
  return scopes.map(scope => {
    const visibility = config.scopes[scope].visibility ?? MIXED
    const row = { scope, visibility }
    for (const role of Object.keys(config.roles ?? {})) {
      row[role] = canRead(config, role, visibility) ? '可讀' : '禁讀'
    }
    return row
  })
}
