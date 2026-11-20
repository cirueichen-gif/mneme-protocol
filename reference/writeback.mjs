#!/usr/bin/env node
// writeback.mjs — 回寫接口（draft / commit），零依賴，Node 22+
//
// 兩段式：draft 只產生草稿；commit 才落盤，而且必須：
//   1. 明確指定角色（--as）
//   2. 再次確認角色（--ack-role，必須與 --as 相同）——擋掉「agent 自己決定身分」
//   3. 帶 --confirm
//   4. 每一條的 quote 都能在來源檔裡逐字找到（否則整批拒收）
//
//   node reference/writeback.mjs draft  --root "D:\記憶庫" --as alpha --from notes.md
//   node reference/writeback.mjs commit --root "D:\記憶庫" --as alpha --ack-role alpha \
//        --draft _drafts/2026-11-20.alpha.md --confirm

import { appendFileSync, existsSync, mkdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isInsideReal, loadConfig, realRoot, safeRel, writableScopes } from './acl.mjs'

const PRIVACY = new Set(['public', 'private', 'secret'])
const MAX_SOURCE_BYTES = 16 * 1024 * 1024

const USAGE = `用法：
  writeback.mjs draft  --root <記憶庫> --as <角色> --from <來源檔|-> [--scope <分區>]
  writeback.mjs commit --root <記憶庫> --as <角色> --ack-role <角色> --draft <草稿> --confirm [--scope <分區>] [--force] [--no-verify]

角色必須由屋主指定；commit 必須再確認一次（--ack-role）。`

const sha256 = text => createHash('sha256').update(text).digest('hex')
const stamp = () => new Date().toISOString()
const datePart = () => stamp().slice(0, 10)
const norm = text => String(text).normalize('NFKC').replace(/\s+/g, ' ').trim()

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
  if (args['ack-role'] === true) throw new UsageError('--ack-role 後面要接角色名稱')
  return args
}

function readStdin() {
  const chunks = []
  const buffer = Buffer.alloc(65536)
  try {
    while (true) {
      const read = readSync(0, buffer, 0, buffer.length, null)
      if (read <= 0) break
      chunks.push(Buffer.from(buffer.subarray(0, read)))
    }
  } catch {
    /* 沒有 stdin */
  }
  return Buffer.concat(chunks).toString('utf8')
}

function requireRoot(args) {
  if (typeof args.root !== 'string') throw new UsageError('缺少 --root <記憶庫路徑>')
  return resolve(args.root)
}

function requireRole(config, args) {
  if (typeof args.as !== 'string') {
    throw new UsageError(`必須指定 --as <角色>（可用：${Object.keys(config.roles ?? {}).join('、')}）`)
  }
  if (!Object.hasOwn(config.roles ?? {}, args.as)) {
    throw new UsageError(`未知角色：${args.as}（可用：${Object.keys(config.roles ?? {}).join('、')}）`)
  }
  return args.as
}

// 內部目錄（_drafts / _audit）必須是單層、且在記憶庫內；不接受 "../x" 這種設定
function internalDir(config, root, value, fallback) {
  const rel = safeRel(root, value ?? fallback)
  if (rel.includes('/')) throw new Error(`writeback 設定必須是單層目錄：${rel}`)
  return rel
}

// 回寫可用的分區：角色的可寫清單扣掉 L0 與 persona（人格層只能由人改）
function writeScopes(config, role) {
  return writableScopes(config, role).filter(scope => {
    const entry = config.scopes[scope] ?? {}
    const layer = entry.layer ?? 'L2'
    const visibility = entry.visibility ?? 'mixed'
    return layer !== 'L0' && visibility !== 'persona'
  })
}

function parseFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (pair) meta[pair[1]] = pair[2].trim()
  }
  return { meta, body: text.slice(match[0].length) }
}

function parseEntries(body) {
  const entries = []
  let current = null
  for (const line of body.split(/\r?\n/)) {
    const statement = /^\s*[-*]?\s*statement\s*[:：]\s*(.*)$/.exec(line)
    if (statement) {
      current = { statement: statement[1].trim(), quote: null, privacy: null }
      entries.push(current)
      continue
    }
    if (!current) continue
    const quote = /^\s*quote\s*[:：]\s*(.*)$/.exec(line)
    if (quote) {
      current.quote = quote[1].trim()
      continue
    }
    const privacy = /^\s*privacy\s*[:：]\s*(.*)$/.exec(line)
    if (privacy) current.privacy = privacy[1].trim()
  }
  return entries
}

const MIN_QUOTE_CHARS = 6 // 太短的片段沒有辨識力（單一個字不算出處）

function validateEntries(entries) {
  if (!entries.length) throw new Error('草稿裡沒有任何條目（需要 - statement: / quote: / privacy: 三欄）')
  entries.forEach((entry, index) => {
    const no = index + 1
    if (!entry.statement) throw new Error(`第 ${no} 條缺少 statement`)
    if (!entry.quote) throw new Error(`第 ${no} 條缺少 quote（回寫必須有逐字出處）`)
    if (!entry.privacy) throw new Error(`第 ${no} 條缺少 privacy（public / private / secret）`)
    if (!PRIVACY.has(entry.privacy)) throw new Error(`第 ${no} 條的 privacy 不合法：${entry.privacy}`)
    if ([...entry.quote].length < MIN_QUOTE_CHARS) {
      throw new Error(`第 ${no} 條的 quote 太短（至少 ${MIN_QUOTE_CHARS} 個字）：${entry.quote}`)
    }
  })
}

function resolveTargetScope(config, root, role, args) {
  const writable = writeScopes(config, role)
  if (!writable.length) throw new Error(`角色 ${role} 沒有可回寫的分區（L0／persona 不接受回寫）`)

  if (typeof args.scope === 'string') {
    if (!Object.hasOwn(config.scopes ?? {}, args.scope)) throw new Error(`未註冊的分區：${args.scope}`)
    if (!writable.includes(args.scope)) throw new Error(`角色 ${role} 不能寫入分區 ${args.scope}`)
    return args.scope
  }
  if (writable.length > 1) {
    throw new UsageError(`角色 ${role} 有多個可寫分區，請用 --scope 指定：${writable.join('、')}`)
  }
  return writable[0]
}

function cmdDraft(config, root, role, args) {
  const draftsDir = internalDir(config, root, config.writeback?.dir, '_drafts')
  if (!writeScopes(config, role).length) throw new Error(`角色 ${role} 沒有可回寫的分區，不能回寫`)

  let text
  let sourceLabel
  if (typeof args.from === 'string' && args.from !== '-') {
    const sourcePath = isAbsolute(args.from) ? args.from : resolve(process.cwd(), args.from)
    if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
      throw new Error(`找不到來源檔：${args.from}`)
    }
    text = readFileSync(sourcePath, 'utf8')
    sourceLabel = sourcePath
  } else {
    text = readStdin()
    sourceLabel = 'stdin'
  }
  if (!text.trim()) throw new Error('沒有內容可寫：請用 --from <檔案> 或從 stdin 輸入')

  const dir = join(realRoot(root), draftsDir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const target = join(dir, `${datePart()}.${role}.md`)

  const first = !existsSync(target)
  if (first) {
    const header = [
      '---',
      'derived: true',
      `role: ${role}`,
      `created: ${stamp()}`,
      `source: ${sourceLabel}`,
      `sourceSha256: ${sha256(text)}`,
      '---',
      ''
    ].join('\n')
    writeFileSync(target, `${header}${text.trim()}\n`, 'utf8')
  } else {
    appendFileSync(target, `\n---\n\n${text.trim()}\n`, 'utf8')
  }

  return {
    draft: `${draftsDir}/${datePart()}.${role}.md`,
    bytes: Buffer.byteLength(text),
    source: sourceLabel,
    created: first
  }
}

function auditPath(config, root) {
  // 整條相對路徑都要驗：不能被 "a/../../x.jsonl" 爬到記憶庫外面
  const rel = safeRel(root, config.writeback?.audit ?? '_audit/writeback.jsonl')
  const parts = rel.split('/')
  const file = parts.pop()
  const dir = parts.join('/') || '_audit'
  return { dir, file, abs: join(realRoot(root), dir, file) }
}

function appendAudit(config, root, record) {
  const { dir, abs } = auditPath(config, root)
  const dirAbs = join(realRoot(root), dir)
  if (!existsSync(dirAbs)) mkdirSync(dirAbs, { recursive: true })
  appendFileSync(abs, JSON.stringify(record) + '\n', 'utf8')
  return abs
}

function readAudit(config, root) {
  const { abs } = auditPath(config, root)
  if (!existsSync(abs)) return []
  return readFileSync(abs, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function cmdCommit(config, root, role, args) {
  // 1. 身分雙錄：agent 不能自己決定要當誰
  if (typeof args['ack-role'] !== 'string') {
    throw new UsageError('commit 必須帶 --ack-role <角色>，再次確認寫入身分')
  }
  if (args['ack-role'] !== role) {
    throw new Error(`--as（${role}）與 --ack-role（${args['ack-role']}）不一致，拒絕寫入`)
  }

  // 2. 草稿必須在 _drafts 底下
  if (typeof args.draft !== 'string') throw new UsageError('請用 --draft <草稿相對路徑>')
  const draftsDir = internalDir(config, root, config.writeback?.dir, '_drafts')
  const draftRel = safeRel(root, args.draft)
  if (!draftRel.startsWith(`${draftsDir}/`)) throw new Error(`只接受 ${draftsDir}/ 底下的草稿：${draftRel}`)

  const draftAbs = join(realRoot(root), draftRel)
  if (!existsSync(draftAbs)) throw new Error(`找不到草稿：${draftRel}`)
  const draftText = readFileSync(draftAbs, 'utf8')
  const draftSha = sha256(draftText)
  const { meta, body } = parseFrontMatter(draftText)

  // 3. 草稿的 role 必須與本次身分相同
  if (meta.role && meta.role !== role) {
    throw new Error(`草稿是 ${meta.role} 產生的，不能用 ${role} 的身分提交`)
  }
  if (meta.derived !== 'true') throw new Error('草稿缺少 derived: true 標記，拒絕寫入')

  // 4. 條目結構完整
  const entries = parseEntries(body)
  validateEntries(entries)

  // 5. quote 必須逐字出現在來源裡，而且來源必須還是 draft 當時那一份
  let sourceText = null
  let sourceShaNow = null
  if (meta.source && meta.source !== 'stdin' && existsSync(meta.source)) {
    try {
      if (statSync(meta.source).size <= MAX_SOURCE_BYTES) {
        sourceText = readFileSync(meta.source, 'utf8')
        sourceShaNow = sha256(sourceText)
      }
    } catch {
      sourceText = null
    }
  }

  // draft 之後才改來源檔，等於繞過驗證：sha 對不上就重來
  if (sourceText && meta.sourceSha256 && meta.sourceSha256 !== sourceShaNow) {
    throw new Error('來源檔在 draft 之後被改過（sha256 不符），請重新產生草稿')
  }

  const quoteOccurrences = []
  if (!sourceText) {
    if (!args['no-verify']) {
      throw new Error('找不到草稿記錄的來源檔，無法核對 quote。確定要寫請加 --no-verify（會留下稽核紀錄）')
    }
  } else {
    const haystack = norm(sourceText)
    entries.forEach((entry, index) => {
      const needle = norm(entry.quote)
      if (!haystack.includes(needle)) {
        throw new Error(`第 ${index + 1} 條的 quote 在來源裡找不到，整批拒收：「${entry.quote}」`)
      }
      quoteOccurrences.push(haystack.split(needle).length - 1)
    })
  }

  // 來源是不是記憶庫自己的檔案：讓屋主一眼看出「這條的來源是 agent 自己寫的筆記」
  let sourceInArchive = false
  if (sourceText) {
    try {
      sourceInArchive = isInsideReal(root, realpathSync(meta.source))
    } catch {
      sourceInArchive = false
    }
  }

  // 6. 落點分區
  const scope = resolveTargetScope(config, root, role, args)
  const targetRel = `${scope}/${datePart()}.md`
  const targetAbs = join(realRoot(root), targetRel)

  const summary = {
    role,
    ackRole: args['ack-role'],
    draft: draftRel,
    draftSha,
    target: targetRel,
    scope,
    entries: entries.length,
    verified: Boolean(sourceText),
    source: meta.source ?? null,
    sourceSha: sourceShaNow,
    sourceInArchive,
    quoteOccurrences,
    bytes: Buffer.byteLength(body)
  }

  // 7. 預覽先於冪等：沒帶 --confirm 就只是預覽
  if (!args.confirm) {
    return { ...summary, written: false, reason: '缺少 --confirm，只做預覽' }
  }

  // 8. 冪等：同一份草稿不重複寫
  if (!args.force) {
    const done = readAudit(config, root).some(
      record => record.status === 'done' && record.draft === draftRel && record.draftSha === draftSha
    )
    if (done) {
      return { ...summary, written: false, reason: '這份草稿已經提交過（要重寫請加 --force）' }
    }
  }

  // 9. 先立帳、再寫入、後結案：任何一步失敗都留得下痕跡
  appendAudit(config, root, { at: stamp(), status: 'pending', ...summary })

  const rendered = entries
    .map(entry => `- statement: ${entry.statement}\n  quote: ${entry.quote}\n  privacy: ${entry.privacy}`)
    .join('\n')
  try {
    if (!existsSync(dirname(targetAbs))) mkdirSync(dirname(targetAbs), { recursive: true })
    const marker = `\n\n<!-- mneme:writeback role=${role} at=${stamp()} draft=${draftRel} -->\n`
    appendFileSync(targetAbs, marker + rendered + '\n', 'utf8')
  } catch (error) {
    appendAudit(config, root, {
      at: stamp(),
      status: 'failed',
      error: String(error?.message ?? error),
      ...summary
    })
    throw error
  }

  appendAudit(config, root, { at: stamp(), status: 'done', ...summary })

  return { ...summary, written: true }
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
    const role = requireRole(config, args)

    if (command === 'draft') {
      console.log(JSON.stringify(cmdDraft(config, root, role, args), null, 2))
      return
    }
    if (command === 'commit') {
      console.log(JSON.stringify(cmdCommit(config, root, role, args), null, 2))
      return
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
