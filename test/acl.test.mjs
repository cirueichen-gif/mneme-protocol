// 權限矩陣測試：任何人改 acl.mjs 或 mneme.mjs，這些必須全部通過。
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  MIXED, canRead, canWrite, loadConfig, matrix, readableScopes, safeRel, visibilityOf, writableScopes
} from '../reference/acl.mjs'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, 'fixtures')
const CLI = resolve(HERE, '..', 'reference', 'mneme.mjs')
const WRITE = resolve(HERE, '..', 'reference', 'writeback.mjs')
const config = loadConfig(ROOT)

const run = (script, args, options = {}) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', ...options })

test('mneme.json 合法且 owner 存在', () => {
  assert.equal(config.version, 1)
  assert.ok(config.roles.owner)
  assert.deepEqual(config.roles.owner.read, ['*'])
})

test('alpha 可讀自己的分區、persona、shared、pair', () => {
  for (const path of ['memory/a.md', 'persona/card.md', 'shared/work.md', 'letters/pair.md']) {
    assert.ok(canRead(config, 'alpha', visibilityOf(config, path)), path)
  }
})

test('alpha 不能讀 beta 的私人分區', () => {
  const visibility = visibilityOf(config, 'secret-beta/beta-note.md')
  assert.equal(visibility, 'private:beta')
  assert.equal(canRead(config, 'alpha', visibility), false)
})

test('beta 不能讀 alpha 的私人分區', () => {
  const visibility = visibilityOf(config, 'memory/alpha-note.md')
  assert.equal(canRead(config, 'beta', visibility), false)
})

test('未註冊目錄一律視為 mixed，只有 owner 可讀', () => {
  const visibility = visibilityOf(config, 'unregistered/mixed.md')
  assert.equal(visibility, MIXED)
  assert.equal(canRead(config, 'owner', visibility), true)
  assert.equal(canRead(config, 'alpha', visibility), false)
  assert.equal(canRead(config, 'beta', visibility), false)
})

test('未知角色直接拒絕，不會退回 owner', () => {
  assert.throws(() => canRead(config, 'nobody', 'shared'), /未知角色/)
})

test('路徑越界被擋', () => {
  assert.throws(() => safeRel(ROOT, '../outside.md'), /超出記憶庫範圍/)
  assert.throws(() => safeRel(ROOT, resolve(ROOT, '..', 'outside.md')), /相對路徑/)
  // Windows 風格的絕對路徑在 Linux 上也要擋（CI 跨平台）
  assert.throws(() => safeRel(ROOT, 'C:\\Windows\\win.ini'), /相對路徑/)
  assert.equal(safeRel(ROOT, 'diary/2026-11-20.md'), 'diary/2026-11-20.md')
})

test('可寫分區依角色不同', () => {
  assert.deepEqual(writableScopes(config, 'alpha'), ['diary'])
  assert.equal(canWrite(config, 'alpha', 'memory'), false)
  assert.deepEqual(readableScopes(config, 'alpha'), ['persona', 'memory', 'diary', 'letters', 'shared'])
})

test('matrix 每列都有每個角色', () => {
  const rows = matrix(config)
  assert.ok(rows.length >= 6)
  for (const row of rows) {
    for (const role of Object.keys(config.roles)) assert.ok(role in row)
  }
})

// ── CLI 行為 ────────────────────────────────────

test('CLI search：alpha 查不到 beta 的祕密', () => {
  const result = run(CLI, ['search', '--root', ROOT, '--as', 'alpha', '祕密'])
  const out = JSON.parse(result.stdout)
  assert.equal(out.count, 0)
})

test('CLI search：owner 查得到同一筆', () => {
  const result = run(CLI, ['search', '--root', ROOT, '--as', 'owner', '祕密'])
  const out = JSON.parse(result.stdout)
  assert.equal(out.count, 1)
  assert.equal(out.results[0].path, 'secret-beta/beta-note.md')
})

test('CLI search：多關鍵字為 AND', () => {
  const both = JSON.parse(run(CLI, ['search', '--root', ROOT, '--as', 'owner', '無糖綠', '香菜']).stdout)
  const one = JSON.parse(run(CLI, ['search', '--root', ROOT, '--as', 'owner', '無糖綠', '不存在詞']).stdout)
  assert.equal(both.count, 1)
  assert.equal(one.count, 0)
})

test('CLI read：無權限與不存在回同樣的訊息', () => {
  const forbidden = run(CLI, ['read', '--root', ROOT, '--as', 'alpha', 'secret-beta/beta-note.md'])
  const missing = run(CLI, ['read', '--root', ROOT, '--as', 'alpha', 'diary/不存在.md'])
  assert.equal(forbidden.status, 1)
  assert.equal(missing.status, 1)
  assert.equal(forbidden.stderr, missing.stderr)
})

test('CLI read：有權限就拿到全文', () => {
  const result = run(CLI, ['read', '--root', ROOT, '--as', 'alpha', 'diary/2026-11-20.md'])
  const out = JSON.parse(result.stdout)
  assert.match(out.content, /海邊/)
})

test('CLI recall：只列清單不回全文', () => {
  const out = JSON.parse(run(CLI, ['recall', '--root', ROOT, '--as', 'alpha']).stdout)
  assert.ok(out.count > 0)
  for (const file of out.files) {
    assert.ok(!('content' in file))
    assert.equal(file.scope.includes('secret-beta'), false)
  }
})

// ── 回寫：只影響暫存副本 ─────────────────────────

function withTempLibrary(fn) {
  const temp = mkdtempSync(join(tmpdir(), 'mneme-'))
  const copy = join(temp, 'library')
  cpSync(ROOT, copy, { recursive: true })
  try {
    return fn(copy)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

const NOTES = [
  '## 條目',
  '- statement: 他喜歡無糖綠。',
  '  quote: 他最喜歡無糖綠。',
  '  privacy: private',
  ''
].join('\n')

test('writeback draft 只寫草稿，不碰正式分區', () => {
  withTempLibrary(root => {
    const notes = join(root, '..', 'notes.txt')
    writeFileSync(notes, NOTES, 'utf8')
    const out = JSON.parse(run(WRITE, ['draft', '--root', root, '--as', 'alpha', '--from', notes]).stdout)
    assert.match(out.draft, /^_drafts\//)
    const before = readdirSync(join(root, 'diary'))
    assert.equal(before.length, 1) // 只有原本那一篇
  })
})

test('writeback commit 沒有 --confirm 時不落盤', () => {
  withTempLibrary(root => {
    const notes = join(root, '..', 'notes.txt')
    writeFileSync(notes, NOTES, 'utf8')
    const { draft } = JSON.parse(run(WRITE, ['draft', '--root', root, '--as', 'alpha', '--from', notes]).stdout)
    const result = run(WRITE, ['commit', '--root', root, '--as', 'alpha', '--draft', draft])
    const out = JSON.parse(result.stdout)
    assert.equal(out.written, false)
    assert.equal(existsSync(join(root, '_audit', 'writeback.jsonl')), false)
  })
})

test('writeback commit 帶 --confirm 才寫入，並留下稽核', () => {
  withTempLibrary(root => {
    const notes = join(root, '..', 'notes.txt')
    writeFileSync(notes, NOTES, 'utf8')
    const { draft } = JSON.parse(run(WRITE, ['draft', '--root', root, '--as', 'alpha', '--from', notes]).stdout)
    const result = run(WRITE, ['commit', '--root', root, '--as', 'alpha', '--draft', draft, '--confirm'])
    const out = JSON.parse(result.stdout)
    assert.equal(out.written, true)
    const audit = readFileSync(join(root, '_audit', 'writeback.jsonl'), 'utf8').trim().split('\n')
    assert.equal(audit.length, 1)
    assert.equal(JSON.parse(audit[0]).role, 'alpha')
  })
})

test('writeback 拒絕沒有 quote 的草稿（防止幻覺進記憶）', () => {
  withTempLibrary(root => {
    const notes = join(root, '..', 'bad.txt')
    writeFileSync(notes, '- statement: 我猜他喜歡咖啡。\n', 'utf8')
    const { draft } = JSON.parse(run(WRITE, ['draft', '--root', root, '--as', 'alpha', '--from', notes]).stdout)
    const result = run(WRITE, ['commit', '--root', root, '--as', 'alpha', '--draft', draft, '--confirm'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /quote/)
  })
})

test('writeback 只接受 _drafts/ 底下的草稿', () => {
  withTempLibrary(root => {
    const result = run(WRITE, ['commit', '--root', root, '--as', 'alpha', '--draft', 'diary/2026-11-20.md', '--confirm'])
    assert.equal(result.status, 1)
  })
})
