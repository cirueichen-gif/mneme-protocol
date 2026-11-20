# Mneme Protocol

**一份讓任何 AI Agent 能讀懂、能調用、能安全回寫「個人長期記憶庫」的公開協定。**

Repository 裡只有**協定、參考實作、模板**，不含任何人的記憶內容。
你的記憶永遠留在你自己的硬碟上，這個 repo 只教 agent 怎麼跟它相處。

---

## 它解決什麼問題

每個人的記憶庫長得不一樣，每個 Agent 的實作也不一樣。結果就是：

- 換一個 Agent，它不知道你有記憶庫，也不會去查
- 知道有，但不知道格式，只能亂翻
- 會查了，但不知道哪些不能讀、哪些不能寫
- 會寫了，但把幻覺寫進你的長期記憶，下次被當成事實

Mneme Protocol 把這四件事變成三份文件 + 一支零依賴的工具：

| 檔案 | 給誰看 | 內容 |
|---|---|---|
| [`AGENTS.md`](AGENTS.md) | **Agent** | 一進來就照這個做：先問什麼、怎麼查、怎麼寫、絕不能做什麼 |
| [`SPEC.md`](SPEC.md) | 人 + Agent | 資料夾結構、`mneme.json` 欄位、權限矩陣、介面定義 |
| [`persona/TEMPLATE.md`](persona/TEMPLATE.md) | 人 | 人格卡模板（誰、怎麼說話、邊界、什麼時候該回想） |

---

## 五分鐘上手

### 1. 在你的記憶庫根目錄放一個 `mneme.json`

複製 [`mneme.example.json`](mneme.example.json)，改成你的分區與角色。
（真正的 token 不放這裡，只放角色名稱與可讀範圍。）

### 2. 把 repo 給你的 Agent

> 「這是 Mneme Protocol：https://github.com/你/mneme-protocol
> 我的記憶庫在 `D:\記憶庫`，我是屋主，請照 AGENTS.md 第 3 節開工。」

### 3. Agent 會自己照著做

它會先讀 `AGENTS.md`、確認資料夾、確認身分、再開始查。不需要你教它指令。

---

## 手動用（給人）

```bash
node reference/mneme.mjs info   --root "D:\記憶庫"
node reference/mneme.mjs search --root "D:\記憶庫" --as owner "第一次見面"
node reference/mneme.mjs read   --root "D:\記憶庫" --as owner "diary/2026-11-20.md"
node reference/mneme.mjs recall --root "D:\記憶庫" --as owner
```

零依賴，只要 Node.js 22+（用到 `node:fs`／`node:path`／`node:crypto`）。

回寫：

```bash
node reference/writeback.mjs draft  --root "D:\記憶庫" --as sister --from notes.txt
node reference/writeback.mjs commit --root "D:\記憶庫" --as sister --draft _drafts/2026-11-20.sister.md --confirm
```

**兩段式**：`draft` 只產生草稿，`commit` 才落盤，而且 `commit` 必須帶 `--confirm`。

---

## 三個設計原則

1. **資料不進 repo，工具才進 repo。** 這個 repo 可以公開，因為它一個 byte 的私人內容都沒有。
2. **歸屬只看分區，不看內文。** 檔案裡提到誰的名字，不會改變它屬於誰。權限在查詢層就擋掉，不是撈完再濾。
3. **寫入預設是草稿。** 任何 Agent 第一次寫都只能產生草稿，人類過目後才進正式記憶。幻覺不准變成事實。

---

## 授權

MIT。拿去用、拿去改、拿去接你自己的記憶庫。

---

## 目錄

```
AGENTS.md                  ← Agent 的入口，最重要
SPEC.md                    ← 協定本體
persona/TEMPLATE.md        ← 人格卡模板
mneme.example.json         ← 清單範例
reference/
  mneme.mjs                ← 查詢（info / search / read / recall）
  writeback.mjs            ← 回寫（draft / commit）
  acl.mjs                  ← 權限判定
test/                      ← 權限矩陣測試 + 合成假資料
.github/workflows/ci.yml   ← 每次 push 跑測試
```
