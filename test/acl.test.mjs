// 權限矩陣、路徑圍籬、回寫守門——任何人改 reference/ 都必須先過這一份。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs'
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

const json = result => JSON.parse(result.stdout)

// ── 記憶庫副本（所有會寫入的測試都在這裡跑）──────────────

function withTempLibrary(fn) {
  const temp = mkdtempSync(join(tmpdir(), 'mneme-'))
  const library = join(temp, 'library')
  cpSync(ROOT, library, { recursive: true })
  try {
    return fn(library, temp)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

function linkDir(target, linkPath) {
  try {
    symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    return false // 沒有權限建連結就跳過該測試
  }
}

// ── 設定與權限模型 ────────────────────────────────

test('mneme.json 合法且 owner 存在', () => {
  assert.equal(config.version, 1)
  assert.deepEqual(config.roles.owner.read, ['*'])
})

test('fixtures 引用的檔案真的存在（防止測試資料漂移）', () => {
  for (const path of ['persona/card.md', 'memory/alpha-note.md', 'shared/work.md', 'letters/pair.md']) {
    assert.ok(existsSync(join(ROOT, path)), `${path} 不存在`)
  }
})

test('alpha 可讀自己的分區、persona、shared、pair', () => {
  for (const path of ['memory/alpha-note.md', 'persona/card.md', 'shared/work.md', 'letters/pair.md']) {
    assert.ok(canRead(config, 'alpha', visibilityOf(config, path)), path)
  }
})

test('跨角色讀取被拒', () => {
  assert.equal(canRead(config, 'alpha', visibilityOf(config, 'secret-beta/beta-note.md')), false)
  assert.equal(canRead(config, 'beta', visibilityOf(config, 'memory/alpha-note.md')), false)
})

test('未註冊目錄視為 mixed，只有 owner 可讀', () => {
  const visibility = visibilityOf(config, 'unregistered/mixed.md')
  assert.equal(visibility, MIXED)
  assert.equal(canRead(config, 'owner', visibility), true)
  assert.equal(canRead(config, 'alpha', visibility), false)
})

test('原型鏈上的名字不算角色', () => {
  for (const bogus of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.throws(() => canRead(config, bogus, 'shared'), /未知角色/, bogus)
  }
})

test('路徑圍籬：越界、絕對路徑、Windows 磁碟路徑、ADS 全部擋', () => {
  assert.throws(() => safeRel(ROOT, '../outside.md'), /超出記憶庫範圍/)
  assert.throws(() => safeRel(ROOT, resolve(ROOT, '..', 'outside.md')), /相對路徑/)
  assert.throws(() => safeRel(ROOT, 'C:\\Windows\\win.ini'), /相對路徑/)
  assert.throws(() => safeRel(ROOT, 'diary/2026-11-20.md::$DATA'), /不允許的字元/)
  assert.throws(() => safeRel(ROOT, 'diary/a\0b.md'), /不允許|不可為空/)
  assert.equal(safeRel(ROOT, 'diary/2026-11-20.md'), 'diary/2026-11-20.md')
})

test('可寫分區依角色不同，且 L0 不在可寫清單', () => {
  assert.deepEqual(writableScopes(config, 'alpha'), ['diary'])
  assert.equal(canWrite(config, 'alpha', 'memory'), false)
  assert.equal(canWrite(config, 'alpha', 'persona'), false)
  assert.deepEqual(readableScopes(config, 'alpha'), ['persona', 'memory', 'diary', 'letters', 'shared'])
})

test('matrix 每列都有每個角色', () => {
  for (const row of matrix(config)) {
    for (const role of Object.keys(config.roles)) assert.ok(role in row)
  }
})

// ── CLI 查詢 ──────────────────────────────────

test('未指定 --as 的資料指令一律拒絕（退出碼 2，不回任何資料）', () => {
  for (const args of [['recall'], ['search', '無糖綠'], ['read', 'diary/2026-11-20.md']]) {
    const result = run(CLI, [...args, '--root', ROOT])
    assert.equal(result.status, 2, args.join(' '))
    assert.equal(result.stdout.trim(), '')
    assert.match(result.stderr, /必須指定 --as/)
  }
})

test('--as 沒接值也要拒絕', () => {
  const result = run(CLI, ['recall', '--root', ROOT, '--as'])
  assert.equal(result.status, 2)
})

test('info 不需要角色', () => {
  const result = run(CLI, ['info', '--root', ROOT])
  assert.equal(result.status, 0)
  assert.equal(json(result).version, 1)
})

test('CLI search：alpha 查不到 beta 的祕密，owner 查得到', () => {
  assert.equal(json(run(CLI, ['search', '--root', ROOT, '--as', 'alpha', '祕密'])).count, 0)
  const owner = json(run(CLI, ['search', '--root', ROOT, '--as', 'owner', '祕密']))
  assert.equal(owner.count, 1)
  assert.equal(owner.results[0].path, 'secret-beta/beta-note.md')
})

test('CLI search：多關鍵字為 AND，且 line 必須同時含所有關鍵字', () => {
  const both = json(run(CLI, ['search', '--root', ROOT, '--as', 'owner', '無糖綠', '香菜']))
  assert.equal(both.count, 1)
  for (const term of ['無糖綠', '香菜']) assert.ok(both.results[0].snippet.includes(term))
  assert.equal(json(run(CLI, ['search', '--root', ROOT, '--as', 'owner', '無糖綠', '不存在的詞'])).count, 0)
})

test('CLI search：空白關鍵字要報錯，不是回 0 筆', () => {
  const result = run(CLI, ['search', '--root', ROOT, '--as', 'owner', '   '])
  assert.notEqual(result.status, 0)
})

test('CLI search：未註冊分區與無權限要分開講', () => {
  const unknown = run(CLI, ['search', '--root', ROOT, '--as', 'owner', '--scope', 'SECRET-BETA', '祕密'])
  assert.match(unknown.stderr, /未註冊的分區/)
  const forbidden = run(CLI, ['search', '--root', ROOT, '--as', 'alpha', '--scope', 'secret-beta', '祕密'])
  assert.match(forbidden.stderr, /不能讀分區/)
})

test('CLI read：無權限、不存在、越界回同一句話', () => {
  const forbidden = run(CLI, ['read', '--root', ROOT, '--as', 'alpha', 'secret-beta/beta-note.md'])
  const missing = run(CLI, ['read', '--root', ROOT, '--as', 'alpha', 'diary/不存在.md'])
  const escape = run(CLI, ['read', '--root', ROOT, '--as', 'alpha', '../outside.md'])
  for (const result of [forbidden, missing, escape]) {
    assert.equal(result.status, 1)
    assert.match(result.stderr, /找不到檔案，或你無權讀取/)
  }
  assert.equal(forbidden.stderr, missing.stderr)
  assert.equal(forbidden.stderr, escape.stderr)
})

test('CLI read：有權限就拿到全文，根目錄檔案不算任何分區', () => {
  const ok = json(run(CLI, ['read', '--root', ROOT, '--as', 'alpha', 'diary/2026-11-20.md']))
  assert.match(ok.content, /海邊/)
  const rootFile = json(run(CLI, ['read', '--root', ROOT, '--as', 'owner', 'mneme.json']))
  assert.equal(rootFile.scope, null)
})

test('CLI read：符號連結／junction 逃逸被擋（跨角色提權）', () => {
  withTempLibrary((library, temp) => {
    const outside = join(temp, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.md'), 'OUTSIDE-CONTENT', 'utf8')
    if (!linkDir(outside, join(library, 'diary', 'linkdir'))) return // 環境不允許建連結

    const escape = run(CLI, ['read', '--root', library, '--as', 'alpha', 'diary/linkdir/secret.md'])
    assert.equal(escape.status, 1, '不得讀到記憶庫外的檔案')
    assert.equal(escape.stdout.trim(), '')

    // 指到別的角色的私人分區，同樣要擋
    if (linkDir(join(library, 'secret-beta'), join(library, 'diary', 'to-beta'))) {
      const cross = run(CLI, ['read', '--root', library, '--as', 'alpha', 'diary/to-beta/beta-note.md'])
      assert.equal(cross.status, 1, '不得透過連結讀到別人的分區')
    }
  })
})

test('CLI search 不會列出連結出去的目錄', () => {
  withTempLibrary((library, temp) => {
    const outside = join(temp, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.md'), '燈塔 祕密', 'utf8')
    if (!linkDir(outside, join(library, 'diary', 'linkdir'))) return
    const out = json(run(CLI, ['search', '--root', library, '--as', 'owner', '燈塔']))
    assert.equal(out.results.some(r => r.path.includes('linkdir')), false)
  })
})

test('CLI recall：只列清單、不含無權限分區', () => {
  const out = json(run(CLI, ['recall', '--root', ROOT, '--as', 'alpha']))
  assert.ok(out.count > 0)
  for (const file of out.files) {
    assert.ok(!('content' in file))
    assert.notEqual(file.scope, 'secret-beta')
    assert.notEqual(file.scope, 'unregistered')
  }
})

// ── 回寫守門 ──────────────────────────────────

const SOURCE = [
  '今天是 2026-11-20，他提到他最喜歡無糖綠。',
  '他說他討厭香菜，還會挑出來。',
  ''
].join('\n')

const NOTES = [
  '- statement: 他喜歡無糖綠。',
  '  quote: 他最喜歡無糖綠',
  '  privacy: private',
  '- statement: 他討厭香菜。',
  '  quote: 他說他討厭香菜',
  '  privacy: public',
  ''
].join('\n')

function prepare(library, temp, { notes = NOTES, source = SOURCE, role = 'alpha' } = {}) {
  const sourcePath = join(temp, 'source.txt')
  const notesPath = join(temp, 'notes.txt')
  writeFileSync(sourcePath, source, 'utf8')
  writeFileSync(notesPath, notes, 'utf8')
  const drafted = run(WRITE, ['draft', '--root', library, '--as', role, '--from', sourcePath])
  assert.equal(drafted.status, 0, drafted.stderr)
  const draft = json(drafted).draft
  // 草稿內容換成 notes（保留 draft 產生並驗證過的 front matter）
  const draftAbs = join(library, draft)
  const head = readFileSync(draftAbs, 'utf8').split('\n').slice(0, 7).join('\n')
  writeFileSync(draftAbs, `${head}\n\n${notes}`, 'utf8')
  return { draft, sourcePath, notesPath }
}

test('draft 沒帶 --as 直接拒絕（不會默默當 owner）', () => {
  withTempLibrary((library, temp) => {
    const notesPath = join(temp, 'notes.txt')
    writeFileSync(notesPath, NOTES, 'utf8')
    const result = run(WRITE, ['draft', '--root', library, '--from', notesPath])
    assert.equal(result.status, 2)
    assert.equal(existsSync(join(library, '_drafts')), false)
  })
})

test('commit 沒帶 --ack-role 或身分不一致都要拒絕', () => {
  withTempLibrary((library, temp) => {
    const { draft } = prepare(library, temp)
    const missing = run(WRITE, ['commit', '--root', library, '--as', 'alpha', '--draft', draft, '--confirm'])
    assert.equal(missing.status, 2)
    const mismatch = run(WRITE, ['commit', '--root', library, '--as', 'alpha', '--ack-role', 'owner', '--draft', draft, '--confirm'])
    assert.equal(mismatch.status, 1)
    assert.match(mismatch.stderr, /不一致/)
  })
})

test('草稿是別人產生的，不能用我的身分提交', () => {
  withTempLibrary((library, temp) => {
    const { draft } = prepare(library, temp, { role: 'beta' })
    const result = run(WRITE, ['commit', '--root', library, '--as', 'alpha', '--ack-role', 'alpha', '--draft', draft, '--confirm'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /草稿是 beta 產生的/)
  })
})

test('quote 在來源裡找不到 → 整批拒收（防幻覺）', () => {
  withTempLibrary((library, temp) => {
    const diaryFile = join(library, 'diary', `${new Date().toISOString().slice(0, 10)}.md`)
    const before = existsSync(diaryFile) ? readFileSync(diaryFile, 'utf8') : null
    const { draft } = prepare(library, temp, {
      notes: ['- statement: 他在火星有房子。', '  quote: 我在火星有房子', '  privacy: private', ''].join('\n')
    })
    const result = run(WRITE, ['commit', '--root', library, '--as', 'alpha', '--ack-role', 'alpha', '--draft', draft, '--confirm'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /quote 在來源裡找不到/)
    const after = existsSync(diaryFile) ? readFileSync(diaryFile, 'utf8') : null
    assert.equal(after, before, '被拒收的草稿不得動到既有記憶檔')
  })
})

test('缺 statement / quote / privacy 或 privacy 不合法都拒收', () => {
  const cases = [
    ['- statement: 只有這句話。', /缺少 quote/],
    ['- quote: 他最喜歡無糖綠', /沒有任何條目|缺少 statement/],
    ['- statement: x。\n  quote: 他最喜歡無糖綠', /缺少 privacy/],
    ['- statement: x。\n  quote: 他最喜歡無糖綠\n  privacy: 頂級機密', /privacy 不合法/]
  ]
  for (const [notes, pattern] of cases) {
    withTempLibrary((library, temp) => {
      const { draft } = prepare(library, temp, { notes: `${notes}\n` })
      const result = run(WRITE, ['commit', '--root', library, '--as', 'alpha', '--ack-role', 'alpha', '--draft', draft, '--confirm'])
      assert.equal(result.status, 1, notes)
      assert.match(result.stderr, pattern)
    })
  }
})

test('commit 沒有 --confirm 只預覽，不落盤', () => {
  withTempLibrary((library, temp) => {
    const { draft } = prepare(library, temp)
    const result = run(WRITE, ['commit', '--root', library, '--as', 'alpha', '--ack-role', 'alpha', '--draft', draft])
    assert.equal(json(result).written, false)
    assert.equal(existsSync(join(library, '_audit')), false)
    assert.equal(readdirSync(join(library, 'diary')).length, 1)
  })
})

test('commit 帶 --confirm 才寫入，並留下 pending→done 稽核', () => {
  withTempLibrary((library, temp) => {
    const { draft } = prepare(library, temp)
    const out = json(run(WRITE, ['commit', '--root', library, '--as', 'alpha', '--ack-role', 'alpha', '--draft', draft, '--confirm']))
    assert.equal(out.written, true)
    assert.equal(out.scope, 'diary')
    assert.equal(out.verified, true)
    const audit = readFileSync(join(library, '_audit', 'writeback.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(audit.map(r => r.status), ['pending', 'done'])
    assert.equal(audit[1].draft, draft)
    const diary = readFileSync(join(library, 'diary', out.target.split('/')[1]), 'utf8')
    assert.match(diary, /無糖綠/)
    assert.doesNotMatch(diary, /derived: true/) // 記憶檔裡不夾 front matter
  })
})

test('同一份草稿不會重複寫入（冪等）', () => {
  withTempLibrary((library, temp) => {
    const { draft } = prepare(library, temp)
    const args = ['commit', '--root', library, '--as', 'alpha', '--ack-role', 'alpha', '--draft', draft, '--confirm']
    assert.equal(json(run(WRITE, args)).written, true)
    const second = json(run(WRITE, args))
    assert.equal(second.written, false)
    assert.match(second.reason, /已經提交過/)
    const forced = json(run(WRITE, [...args, '--force']))
    assert.equal(forced.written, true)
  })
})

test('L0／persona 分區不接受回寫；多重可寫分區必須指定 --scope', () => {
  withTempLibrary((library, temp) => {
    const { draft } = prepare(library, temp, { role: 'owner' })
    const toPersona = run(WRITE, ['commit', '--root', library, '--as', 'owner', '--ack-role', 'owner', '--draft', draft, '--scope', 'persona', '--confirm'])
    assert.equal(toPersona.status, 1)
    assert.match(toPersona.stderr, /不能寫入分區 persona/)

    const noScope = run(WRITE, ['commit', '--root', library, '--as', 'owner', '--ack-role', 'owner', '--draft', draft, '--confirm'])
    assert.equal(noScope.status, 2)
    assert.match(noScope.stderr, /--scope/)

    const ok = json(run(WRITE, ['commit', '--root', library, '--as', 'owner', '--ack-role', 'owner', '--draft', draft, '--scope', 'diary', '--confirm']))
    assert.equal(ok.written, true)
    assert.equal(ok.target.startsWith('diary/'), true)
  })
})

test('writeback 設定不能逃出記憶庫', () => {
  withTempLibrary((library, temp) => {
    const configPath = join(library, 'mneme.json')
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
    cfg.writeback.dir = '../../escaped'
    writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8')
    const sourcePath = join(temp, 'source.txt')
    writeFileSync(sourcePath, SOURCE, 'utf8')
    const result = run(WRITE, ['draft', '--root', library, '--as', 'alpha', '--from', sourcePath])
    assert.equal(result.status, 1)
    assert.equal(existsSync(join(temp, 'escaped')), false)
  })
})

test('commit 只接受 _drafts/ 底下的草稿', () => {
  withTempLibrary(library => {
    const result = run(WRITE, ['commit', '--root', library, '--as', 'alpha', '--ack-role', 'alpha', '--draft', 'diary/2026-11-20.md', '--confirm'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /只接受 _drafts/)
  })
})

test('writeback.requireConfirm 設成 false 的設定要被拒絕載入', () => {
  withTempLibrary(library => {
    const configPath = join(library, 'mneme.json')
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
    cfg.writeback.requireConfirm = false
    writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8')
    const result = run(CLI, ['info', '--root', library])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /requireConfirm/)
  })
})

// ── 第二輪審查的回歸測試 ─────────────────────────

test('記憶庫本身是 junction 時，recall／search 的結果要跟直連一致', () => {
  const temp = mkdtempSync(join(tmpdir(), 'mneme-link-'))
  try {
    const real = join(temp, 'real-lib')
    cpSync(ROOT, real, { recursive: true })
    const link = join(temp, 'link-lib')
    if (!linkDir(real, link)) return // 環境不允許建連結

    const direct = json(run(CLI, ['recall', '--root', real, '--as', 'alpha']))
    const viaLink = json(run(CLI, ['recall', '--root', link, '--as', 'alpha']))
    assert.equal(viaLink.count, direct.count)
    for (const file of viaLink.files) {
      assert.equal(file.path.startsWith('..'), false, `path 跑到庫外：${file.path}`)
      assert.notEqual(file.visibility, 'mixed')
    }
    assert.deepEqual(viaLink.files.map(f => f.path).sort(), direct.files.map(f => f.path).sort())

    const hit = json(run(CLI, ['search', '--root', link, '--as', 'alpha', '無糖綠']))
    assert.equal(hit.count, 1, '透過連結也要搜得到')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('audit 路徑不能爬到記憶庫外', () => {
  withTempLibrary((library, temp) => {
    const configPath = join(library, 'mneme.json')
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
    cfg.writeback.audit = 'a/../../escaped.jsonl'
    writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8')
    const { draft } = prepare(library, temp)
    const result = run(WRITE, ['commit', '--root', library, '--as', 'alpha', '--ack-role', 'alpha', '--draft', draft, '--confirm'])
    assert.equal(result.status, 1)
    assert.equal(existsSync(join(temp, 'escaped.jsonl')), false)
  })
})

test('draft 之後改來源檔 → sha 不符，拒收', () => {
  withTempLibrary((library, temp) => {
    const { draft, sourcePath } = prepare(library, temp)
    writeFileSync(sourcePath, '來源被改過了，這裡沒有那句話。', 'utf8')
    const result = run(WRITE, ['commit', '--root', library, '--as', 'alpha', '--ack-role', 'alpha', '--draft', draft, '--confirm'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /sha256 不符/)
  })
})

test('太短的 quote 不算出處', () => {
  withTempLibrary((library, temp) => {
    const { draft } = prepare(library, temp, {
      notes: ['- statement: x。', '  quote: 最', '  privacy: private', ''].join('\n')
    })
    const result = run(WRITE, ['commit', '--root', library, '--as', 'alpha', '--ack-role', 'alpha', '--draft', draft, '--confirm'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /太短/)
  })
})

test('已提交的草稿再次預覽，要回「預覽」而不是「已提交」', () => {
  withTempLibrary((library, temp) => {
    const { draft } = prepare(library, temp)
    const args = ['commit', '--root', library, '--as', 'alpha', '--ack-role', 'alpha', '--draft', draft, '--confirm']
    assert.equal(json(run(WRITE, args)).written, true)
    const preview = json(run(WRITE, ['commit', '--root', library, '--as', 'alpha', '--ack-role', 'alpha', '--draft', draft]))
    assert.match(preview.reason, /只做預覽/)
  })
})

test('--limit 不是正整數要報錯', () => {
  for (const value of ['abc', '0', '-3']) {
    const result = run(CLI, ['search', '--root', ROOT, '--as', 'owner', '--limit', value, '無糖綠'])
    assert.equal(result.status, 2, `--limit ${value}`)
  }
})

test('唯一可寫分區是 persona 的角色，連 draft 都不該成功', () => {
  withTempLibrary((library, temp) => {
    const configPath = join(library, 'mneme.json')
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
    cfg.roles.alpha.write = ['persona']
    writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8')
    const sourcePath = join(temp, 'source.txt')
    writeFileSync(sourcePath, SOURCE, 'utf8')
    const result = run(WRITE, ['draft', '--root', library, '--as', 'alpha', '--from', sourcePath])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /沒有可回寫的分區/)
  })
})
