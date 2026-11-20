#!/usr/bin/env node
// writeback.mjs — 回寫接口（draft / commit），零依賴，Node 22+
//
// 兩段式：draft 只產生草稿；commit 才落盤，且必須帶 --confirm。
//
//   node reference/writeback.mjs draft  --root "D:\記憶庫" --as alpha --from notes.md
//   node reference/writeback.mjs commit --root "D:\記憶庫" --as alpha --draft _drafts/2026-11-20.alpha.md
//   node reference/writeback.mjs commit --root "D:\記憶庫" --as alpha --draft _drafts/2026-11-20.alpha.md --confirm

import { appendFileSync, existsSync, mkdirSync, readFileSync, readSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { canWrite, loadConfig, safeRel, writableScopes } from './acl.mjs'

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) args[key] = true
      else { args[key] = next; i++ }
    } else args._.push(token)
  }
  return args
}

const stamp = () => new Date().toISOString()
const datePart = () => stamp().slice(0, 10)

function fail(message) {
  console.error(`✗ ${message}`)
  process.exitCode = 1
  throw new Error(message)
}

function readInput(from) {
  if (typeof from === 'string') {
    if (!existsSync(from)) fail(`找不到來源檔：${from}`)
    return { text: readFileSync(from, 'utf8'), source: from }
  }
  // 沒有 --from 就從 stdin 讀
  const chunks = []
  const buffer = Buffer.alloc(65536)
  try {
    while (true) {
      const read = readSync(0, buffer, 0, buffer.length, null)
      if (read <= 0) break
      chunks.push(Buffer.from(buffer.subarray(0, read)))
    }
  } catch {
    /* 沒有 stdin 就當作空 */
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) fail('沒有內容可寫：請用 --from <檔案> 或從 stdin 輸入')
  return { text, source: 'stdin' }
}

function cmdDraft(config, root, role, args) {
  const writable = writableScopes(config, role)
  if (!writable.length) fail(`角色 ${role} 沒有可寫分區，不能回寫`)

  const { text, source } = readInput(args.from)
  const draftsDir = resolve(root, config.writeback?.dir ?? '_drafts')
  if (!existsSync(draftsDir)) mkdirSync(draftsDir, { recursive: true })

  const target = join(draftsDir, `${datePart()}.${role}.md`)
  const header = [
    '---',
    'derived: true',
    `role: ${role}`,
    `created: ${stamp()}`,
    `source: ${source}`,
    '---',
    '',
    '## 條目',
    ''
  ].join('\n')

  // 追加，不覆寫既有草稿
  appendFileSync(target, `\n---\n\n${header}${text.trim()}\n`, 'utf8')
  return { draft: target.slice(resolve(root).length + 1).replaceAll('\\', '/'), bytes: Buffer.byteLength(text), source }
}

function cmdCommit(config, root, role, args) {
  if (typeof args.draft !== 'string') fail('請用 --draft <草稿相對路徑>')
  const rel = safeRel(root, args.draft)
  const draftsDir = (config.writeback?.dir ?? '_drafts').split('/')[0]
  if (!rel.startsWith(`${draftsDir}/`)) fail(`只接受 ${draftsDir}/ 底下的草稿：${rel}`)

  const abs = resolve(root, rel)
  if (!existsSync(abs)) fail(`找不到草稿：${rel}`)
  const body = readFileSync(abs, 'utf8')
  if (!body.includes('derived: true')) fail('草稿缺少 derived: true 標記，拒絕寫入')
  if (!/quote\s*[:：]/.test(body)) fail('草稿沒有任何 quote 欄位，拒絕寫入（回寫必須有逐字出處）')

  const writable = writableScopes(config, role)
  if (!writable.length) fail(`角色 ${role} 沒有可寫分區`)
  const scope = writable.find(name => canWrite(config, role, name))
  const targetRel = `${scope}/${datePart()}.md`
  const targetAbs = resolve(root, targetRel)

  const summary = { role, draft: rel, target: targetRel, bytes: Buffer.byteLength(body), willCreate: !existsSync(targetAbs) }

  if (!args.confirm) {
    console.log(JSON.stringify({ ...summary, written: false, reason: '缺少 --confirm，只做預覽' }, null, 2))
    return
  }

  if (!existsSync(dirname(targetAbs))) mkdirSync(dirname(targetAbs), { recursive: true })
  const marker = `\n\n<!-- mneme:writeback role=${role} at=${stamp()} draft=${rel} -->\n`
  appendFileSync(targetAbs, marker + body.trim() + '\n', 'utf8')

  const auditRel = config.writeback?.audit ?? '_audit/writeback.jsonl'
  const auditAbs = resolve(root, auditRel)
  if (!existsSync(dirname(auditAbs))) mkdirSync(dirname(auditAbs), { recursive: true })
  appendFileSync(auditAbs, JSON.stringify({ ...summary, at: stamp(), written: true }) + '\n', 'utf8')

  console.log(JSON.stringify({ ...summary, written: true, audit: auditRel }, null, 2))
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  try {
    if (!command || command === 'help') {
      console.log('用法：writeback.mjs <draft|commit> --root <路徑> --as <角色> [--from <檔>]')
      return
    }
    if (typeof args.root !== 'string') fail('缺少 --root <記憶庫路徑>')
    const root = resolve(args.root)
    const config = loadConfig(root)
    const role = typeof args.as === 'string' ? args.as : 'owner'
    if (!config.roles?.[role]) fail(`未知角色：${role}`)

    if (command === 'draft') return console.log(JSON.stringify(cmdDraft(config, root, role, args), null, 2))
    if (command === 'commit') return void cmdCommit(config, root, role, args)
    fail(`未知指令：${command}`)
  } catch (error) {
    if (!process.exitCode) {
      console.error(`✗ ${error.message}`)
      process.exitCode = 1
    }
  }
}

main()
