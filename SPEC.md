# SPEC — Mneme Protocol v1

本文件定義「個人長期記憶庫」的目錄結構、權限模型與介面契約。
任何工具、語言、Agent 只要符合本節，即為合規實作。

---

## 1. 資料根目錄

一個記憶庫就是一個資料夾，根目錄**必須**有 `mneme.json`。

```
<root>/
├── mneme.json              必要：清單與權限
├── persona/                人格卡（L0）
│   └── *.md
├── memory/                 長效記憶（L1）
│   └── *.md
├── diary/                  逐日紀錄（L2）
│   └── YYYY-MM-DD.md
├── letters/                信件、長文（L2，選用）
├── shared/                 共用區（選用）
├── _drafts/                回寫草稿（工具產生）
└── _audit/                 寫入稽核紀錄（工具產生）
```

`persona/`、`memory/`、`diary/` 為保留名稱。其餘分區自由命名，但必須在 `mneme.json` 的 `scopes` 註冊。

---

## 2. `mneme.json`

```jsonc
{
  "version": 1,                       // 必要，目前只有 1
  "name": "任意標籤",                  // 選用，不會顯示給外人
  "scopes": {
    "<分區名稱>": {
      "visibility": "persona",        // 必要：可見性標籤，見第 3 節
      "layer": "L0",                  // 選用：L0 / L1 / L2，預設 L2
      "budgetKB": 8,                  // 選用：載入預算
      "note": "給人看的說明"            // 選用
    }
  },
  "roles": {
    "<角色名稱>": {
      "read":  ["persona", "private:alpha", "shared"],   // 必要：可見性白名單
      "write": ["diary"]                                 // 選用：可寫分區
    }
  },
  "writeback": {
    "dir": "_drafts",                                    // 草稿目錄，預設 _drafts
    "audit": "_audit/writeback.jsonl",                   // 稽核檔，預設此值
    "requireConfirm": true                               // 預設 true，不可由角色關閉
  }
}
```

**紅線：`mneme.json` 不得包含任何 token、金鑰、密碼。**
身分驗證屬於實作層（本機 CLI 用 `--as`，HTTP 用標頭），協定只定義「角色 → 可見性」的對應。

---

## 3. 可見性（visibility）

可見性是自由字串，但建議用下列慣例：

| 值 | 意義 | 誰能讀 |
|---|---|---|
| `persona` | 人格卡 | 所有角色 |
| `shared` | 共用區 | 所有角色 |
| `pair` | 兩個角色之間的往來（唯讀） | 兩個角色 |
| `private:<角色>` | 該角色的私人分區 | 只有該角色與 `owner` |
| `mixed` | 未分類／混合歸檔 | **只有 `owner`** |

規則：

1. **歸屬只看分區，不看內文。** 檔案內容提到誰的名字，不改變它的可見性。
2. **`mixed` 是預設拒絕。** 未在 `scopes` 註冊的頂層目錄一律視為 `mixed`。
3. **`owner` 必須存在，且 `read` 含 `"*"`。** 沒有 `owner` 的 `mneme.json` 不合法。

---

## 4. 權限判定順序

```
relPath → scope（第一段目錄）→ visibility（scopes[scope].visibility 或 mixed）
       → role（--as 或請求標頭）→ roles[role].read 是否包含該 visibility
```

- 判定必須發生在**取資料之前**（查詢層），不是撈完再過濾。
- 無權限與不存在**回傳相同結果**，不洩漏「這裡有東西但不能給你」。
- 路徑必須解析後仍在 `<root>` 之內；`..`、絕對路徑、符號連結逃逸一律拒絕。

---

## 5. 介面契約

實作方式不限，但行為必須一致。

### 5.0 共同前提：身分必須被明確指定

- **實作不得默默預設角色。** `owner` 不是預設值，是必須被指定的身分。
- 呼叫端沒有帶角色時：CLI 至少要在 stderr 告警；HTTP 一律 401。
- 不得「先以 owner 查詢、之後再想辦法縮小範圍」。

### 5.1 `info`

輸出：`version`、`scopes`（名稱、visibility、layer、預算）、`roles`（名稱、可讀可見性、可寫分區）。

### 5.2 `recall`

依 layer 順序列出可讀分區的檔案：`path`、`bytes`、`layer`、`firstHeading`。
**只列清單與標題，不回全文。** 超出 `budgetKB` 的以 `truncated: true` 標記。

### 5.3 `search`

輸入：一至多個關鍵字（AND）、可選分區、可選上限。
輸出：陣列，元素為

```json
{ "path": "diary/2026-11-20.md", "scope": "diary", "visibility": "private:alpha",
  "line": 42, "snippet": "…命中片段…" }
```

- 比對前做 NFKC 正規化與小寫化。
- 只回傳呼叫者角色可讀的結果。
- 無結果回空陣列，不是錯誤。

### 5.4 `read`

輸入：相對路徑。
輸出：該檔全文，或拒絕（不存在／無權限／越界，三者回應一致）。

### 5.5 `draft`（寫入第一段）

輸入：角色、內容來源（檔案或 stdin）。
輸出：寫入 `<writeback.dir>/<YYYY-MM-DD>.<role>.md`，回傳該路徑。
**不得**寫入任何正式分區。

草稿格式：

```markdown
---
derived: true
role: alpha
created: 2026-11-20T14:20:00+08:00
source: <來源描述>
---

## 條目
- statement: 半年後仍成立的一句話
  quote: 原文逐字片段
  privacy: private
```

### 5.6 `commit`（寫入第二段）

輸入：草稿路徑、`--confirm`。
沒有 `--confirm` 時**只預覽不落盤**（dry run），退出碼 0，輸出「未寫入」。
有 `--confirm` 時：追加到 `<可寫分區>/<YYYY-MM-DD>.md`，並在 `_audit/writeback.jsonl` 追加一筆：

```json
{ "at": "ISO", "role": "alpha", "draft": "_drafts/…", "target": "diary/2026-11-20.md", "bytes": 123 }
```

寫入方式一律**追加**，不得覆寫既有檔案。

---

## 6. 回寫內容的最低要求

每一條寫入的記憶至少要有：

| 欄位 | 要求 |
|---|---|
| `statement` | 半年後仍成立的一句話 |
| `quote` | 來源中的**逐字**片段（會被程式比對） |
| `privacy` | `public` / `private` / `secret`，不確定就降級 |

湊不出 `quote` 的條目不准寫。這是防止幻覺變成事實的唯一硬門檻。

---

## 7. 選用：SQLite 索引 profile

大於約 5,000 個檔案時，掃描會變慢，可加索引。建議兩張表：

```sql
CREATE TABLE docs (
  id INTEGER PRIMARY KEY, scope TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
  bytes INTEGER, sha256 TEXT, body TEXT
);
CREATE VIRTUAL TABLE terms USING fts5(path, body, tokenize='trigram');
```

- `docs.path` 是相對路徑（反斜線或斜線皆可，實作自行正規化）
- 權限判定仍用 `mneme.json`，索引**不得**成為繞過權限的旁路
- 索引是快取，刪掉必須能從原檔重建

---

## 8. 版本與相容

- `version` 目前只有 `1`。
- 新增欄位視為相容；刪除或改義視為不相容，必須升 `version`。
- 實作遇到不認識的 `version` 必須**拒絕執行並說明**，不得猜測。

---

## 9. 建議的檔案格式

- 文字一律 UTF-8，Markdown。
- 檔名用日期或語意名稱，不要用流水號亂碼。
- 單檔建議 < 200 KB；超過就拆。
