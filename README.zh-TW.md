<p align="center">
  <img src="./icon.png" width="144" alt="FigCC 四圓 Logo">
</p>

<h1 align="center">FigCC</h1>

<p align="center">
  在 Figma 裡使用本機 Codex 或 Claude Code 檢查、理解並修改畫布的設計 Agent。
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./CONTRIBUTING.md">參與開發</a> ·
  <a href="./LICENSE">MIT 授權</a> ·
  <a href="./NOTICE.md">來源標示</a>
</p>

> [!IMPORTANT]
> FigCC（原名 FigCodex）是以 [PavelLaptev/FigClaw](https://github.com/PavelLaptev/FigClaw) 為基礎的衍生作品，依 MIT License 使用與修改。FigCC 將原本由 Figma 直接連線 Claude API 的方式改為本機 bridge，可接 Codex CLI 與 Claude Code，並新增不同的執行架構、權限模式、介面與功能。完整說明請見 [NOTICE.md](NOTICE.md)。

FigCC 會把 Figma 外掛連接到 Mac 上已安裝、已登入的 Codex CLI 或 Claude Code。Figma 裡不需要填 Claude API Key，也不需要另外保存 OpenAI 模型 API Key。Codex 使用 App Server；Claude 使用官方 Agent SDK 與 bridge 內的 FigCC MCP server。兩個 Provider 各自保存原生 conversation identity。

FigCC 是獨立的社群專案，與 Figma、Anthropic、OpenAI 均無隸屬或官方背書關係。

## FigCC 新增的功能

相較於上游 FigClaw，目前 FigCC 包含：

- **雙本機執行環境**：可使用 Codex CLI App Server 或 Claude Code Agent SDK，沿用各 CLI 既有登入，外掛 iframe 不直接呼叫模型 API。
- **Provider 隔離聊天**：切換 Codex／Claude 一律開啟全新空白聊天。從 History 開啟時會自動回到該聊天原本的 Provider，且只續接原生 Codex thread 或 Claude session。
- **即時執行設定**：讀取目前 Provider 實際提供的模型、reasoning effort 與權限控制，在 Send 旁即可切換。
- **原生續接**：分開保存 Codex thread ID 與 Claude session ID，後續訊息與跨 Figma 檔案恢復聊天時會續接正確的 conversation。
- **感知畫布選取內容**：送出前會在 composer 顯示選取的文字、圖片、Frame 或混合節點；視覺節點包含有上限的渲染預覽，文字節點包含有上限的文字與樣式資料。
- **參考圖片**：同一則訊息可加入上傳圖片、貼上的圖片，以及 Figma 選取節點的圖片預覽。
- **檔案附件**：透過迴紋針附加常見文件、資料檔與程式碼；經驗證的 bridge 會保存有大小上限的私密副本，並提供給目前選擇的本機 Provider。
- **畫布操作直接執行**：Figma 檢查與畫布修改都直接透過 plugin sandbox 執行，一般繪圖不再被不相干的授權審查擋住。
- **可選本機檔案權限**：Codex 預設使用 CLI 的 Read only profile；明確要求專案檔案寫入時才自動審查升級。Workspace 與 Full access 必須由使用者主動選擇。
- **有驗證的本機傳輸**：bridge 只綁定 loopback，並要求持久保存的隨機 pairing token。
- **macOS 常駐 bridge**：可安裝使用者層級 LaunchAgent，登入時啟動，意外退出時自動重啟。
- **可選專案工作區**：Settings 會開啟 macOS 原生資料夾選擇器；選定資料夾會成為 Provider 的專案根目錄，其中即時的 `skills/` 會與 FigCC 內建 skills 合併。
- **共用原生 Skills**：以 `skills/<name>/SKILL.md` 作為唯一來源，並連結到 `.agents/skills` 與 `.claude/skills`；只需上傳、啟用、`@mention`、建立或更新一次。
- **歷史記錄與遷移**：聊天可跨 Figma 檔案保存，並相容匯入舊 FigClaw 的設定、歷史、skills 與 pairing token。
- **雙 Provider 視覺介面**：包含 FigCC 四圓品牌圖形、原生 UI 字體、連線與工具狀態、適合 400 px 外掛面板的模型／effort／權限控制，以及內容過長時可垂直捲動的分頁。

## 架構

```text
Figma plugin UI
    ⇅ 已驗證 WebSocket（ws://localhost:4319/ws）
FigCC 本機 bridge
    ├⇄ stdio JSON-RPC → codex app-server
    └⇄ Agent SDK + in-process MCP → Claude Code
    ⇅ tool 呼叫與結果
Figma plugin sandbox → 目前的 Figma 文件
```

FigCC 不會為每個 prompt 重新啟動一次 `codex exec`。Claude 則透過官方 Agent SDK 與受限的 in-process MCP server 執行。兩條路徑都能暫停等待 Figma tool、接收結果、繼續串流，並在之後恢復各自的原生 conversation。

## Figma 工具

| 工具 | 用途 |
| --- | --- |
| `get_selection` | 讀取目前選取項目與序列化節點資料。 |
| `get_page_nodes` | 在限制深度內讀取目前頁面的節點樹。 |
| `get_node_by_id` | 檢查指定 Figma node。 |
| `get_styles` | 列出本機 paint、text、effect 與 grid styles。 |
| `get_variables` | 讀取 variables collection、modes 與解析值。 |
| `get_components` | 列出 components 與 component sets。 |
| `get_pages` | 列出頁面與子節點數量。 |
| `run_figma_code` | 直接執行支援頂層 `await` 的 Figma Plugin API JavaScript。 |
| `fetch_docs` | 讀取 allowlist 內的 Figma Plugin API 參考文件。 |
| `notify` | 顯示 Figma toast。 |
| `download_files` | 下載產生的文字或二進位檔案，多檔時可使用 ZIP。 |
| `create_skill`／`update_skill` | 將 Agent 建立或修改的 skill 保存到選定工作區；未選擇時保存於 FigCC。 |

## 系統需求

- macOS 與 Figma desktop app
- Node.js 18 以上
- 支援 App Server dynamic tools 的新版 Codex CLI，和／或新版 Claude Code
- 已在本機登入要使用的 CLI（執行 `codex login`，或先啟動一次 `claude` 完成登入）

FigCC 會依序搜尋 `CODEX_BIN`、目前 Node／NVM 安裝、ChatGPT desktop app 內附的 Codex，以及 `PATH`，再選擇相容版本中最新的執行檔。如需固定版本，可設定 `CODEX_BIN=/absolute/path/to/codex`。

Claude 會依序搜尋 `CLAUDE_BIN`、Claude Code 常見安裝位置、目前 Node／NVM 安裝與 `PATH`。如需固定版本，可設定 `CLAUDE_BIN=/absolute/path/to/claude`。其中一個 Provider 未安裝時，另一個仍可使用。

## 安裝

```bash
npm install
npm run build
npm run bridge:install
npm run bridge:token
```

`bridge:install` 會將 `com.figcodex.bridge` 註冊為 macOS 使用者層級 LaunchAgent。它會在登入時啟動、意外結束後自動重啟，並把本機 log 寫入 `.figcodex-data/`。

接著匯入 Figma 外掛：

1. 開啟 Figma desktop。
2. 選擇 **Plugins → Development → Import plugin from manifest…**。
3. 選取本專案的 `public/manifest.json`。
4. 開啟 FigCC → **Settings**。
5. Bridge URL 保持 `http://localhost:4319`。
6. 貼上 `npm run bridge:token` 顯示的 token，按 **Save & Connect**。
7. 若要連動既有專案與其中的 `skills/`，可到 **Project workspace → Choose folder…** 選擇資料夾。
8. 等待顯示 **Connected**，回到 **Chat**。

## 使用方式

1. 可先在 Figma 畫布選取一個或多個圖層。相關內容會出現在 composer，送出前可以排除。
2. 輸入要求、貼上或上傳參考圖片、用迴紋針附加文件或程式碼，也可以用 `@skill-name` 叫用 passive skill。
   按 Enter 送出，或按 Shift+Enter 換行。使用中文等輸入法組字時，Enter 只會確認目前的選字，不會送出；組字結束後再按一次 Enter 才會送出。
3. 在標題右側選擇 **Codex** 或 **Claude**。切換 Provider 會建立全新空白聊天，不會轉移上下文。
4. 需要時在 **Send** 左側選擇該 Provider 的即時模型、reasoning effort 與本機檔案權限 profile。
5. 執行期間可在對話中看到串流回答、工具與自動審查狀態。History 會顯示 Provider 標籤，開啟後自動切回正確模式。

## 專案工作區

Settings 可透過 macOS 原生資料夾選擇器連結一個本機專案。通過驗證的 bridge 會把選擇結果保存在 `.figcodex-data/workspace.json`；Figma iframe 不能自行送入任意檔案路徑。

- 選定的資料夾會成為新 Codex thread 與 Claude session 的工作目錄和受限 workspace root。
- 預設仍為 Read only。選擇資料夾不等於授權寫入；本機變更仍由 **Workspace** 或其他明確選擇的 Provider 權限 profile 控制。
- FigCC 會合併內建 skills 與 `<選定資料夾>/skills/<name>/SKILL.md`；若 id 相同，以工作區版本覆蓋內建版本。
- Skill 會直接從磁碟讀取並監看新增、修改與刪除；FigCC 不會複製內容，也不會建立另一份索引。
- 新建或匯入的 skill 會寫入選定專案的 `skills/`；未選擇專案時才使用 FigCC 內建的 `skills/`。
- 切換工作區會建立全新空白聊天；保存的原生 thread／session 只有在記錄的工作區仍相符時才會續接。

範例：

- 「說明目前選取的元件與 variants。」
- 「建立一個 auto layout button，padding 16/10、圓角 8。」
- 「把目前選取內容的顏色與文字樣式轉成 Figma variables。」
- 「把所有選取圖層改成適合檔名的命名。」
- 「把本頁所有 icon frame 匯出成 SVG 與 PNG。」
- 「依照這張參考圖重新設計選取的 card。」

## Skills

自訂 skill 是 Markdown 指令文件：

- **Active**：每個 turn 都會加入。
- **Passive**：只有以 `@skill-name` 指定時才會加入。
- 直接從檔案系統讀到、但尚未保存模式的 skill，預設為 **Passive**，避免預裝或外部新增的指令在未明確啟用時改變所有對話。
- Agent 可以透過受審查的 dynamic tools 建立或更新 skill。
- 內建範例以標準 skill package 形式位於 [`skills/`](skills/)；選定專案也可以在自己的 `skills/` 加入即時套件。
- `.agents/skills` 與 `.claude/skills` 都連到這個唯一目錄，因此兩個 CLI 會同步看到更新。
- bridge 會直接監聽內建與選定專案的目錄；從外部新增、修改或刪除檔案後，會重新讀取磁碟內容並自動推送至 Plugin，不會建立另一份 skill 索引。
- FigCC 專用的 Provider session 會停用原生的專案 skill 自動載入；canonical skill 只有透過 Plugin 的 **Active** 開關或明確的 `@skill-name` 才會進入 prompt。

第三方 skill 應視為類似程式碼的指令；啟用前請先閱讀內容。

## 安全與權限

- Bridge 預設只綁定 `127.0.0.1`，沒有 pairing token 的 client 會被拒絕。
- Pairing token 與 Codex／Claude 登入憑證只留在本機，不會加入 prompt。
- Codex 預設使用 live `:read-only` 權限 profile，搭配 `approvalPolicy: on-request` 與 `approvalsReviewer: auto_review`；較舊的相容 CLI 會安全退回 `sandbox: read-only`。
- 權限選單來自 Codex App Server 的 live catalog。`:workspace` 可在專案 sandbox 內寫入；`:danger-full-access` 會移除檔案沙箱，介面會以警告選項顯示。
- Claude 模型來自 Agent SDK live catalog。Claude 預設為 `:read-only`；Workspace、Auto 與 Full access 會對應 Claude Code 的原生權限模式。
- 專用畫布 Agent 不會載入使用者設定的 MCP servers；Claude 只會收到 bridge 內的 FigCC MCP server。
- 切換 Provider 不會複製 transcript 或原生 ID；History 只會續接該聊天記錄的 Provider。
- 包含 `run_figma_code` 在內的 Figma 畫布工具會直接送進 plugin sandbox，不經 bridge auto-review；skill storage 與下載仍保留獨立、fail-closed 的審查邊界。
- Figma manifest 沒有 wildcard 網路權限，只允許本機 bridge 與 allowlist 文件來源。
- 畫布選取預覽在按下 Send 前不會離開外掛。
- `.figcodex-data/`、`.figclaw-data/`、logs、tokens 與產生的 App Server schemas 都不會加入 git。

`run_figma_code` 可以不經核准停頓，直接修改目前開啟的 Figma 文件。重要檔案請保留 Figma version history，並依影響程度檢查產生的行為。權限選單控制的是本機專案檔案，不是 Figma 畫布。

## 常用指令

| 指令 | 說明 |
| --- | --- |
| `npm run dev` | 監看並重新建置外掛。 |
| `npm run build` | 建置 `public/index.html` 與 `public/code.js`。 |
| `npm run check` | 建置並執行所有本機測試。 |
| `npm run bridge` | 只在目前 terminal 執行 bridge。 |
| `npm run bridge:install` | 安裝並啟動 macOS 常駐使用者服務。 |
| `npm run bridge:status` | 檢查常駐 bridge 狀態。 |
| `npm run bridge:uninstall` | 停止並移除常駐 bridge。 |
| `npm run bridge:token` | 顯示持久保存的 pairing token。 |
| `npm run bridge:smoke` | 測試真實 Codex tool call 與 thread resume。 |
| `npm run bridge:claude-smoke` | 測試真實 Claude MCP tool call 與原生 session resume。 |
| `npm run bridge:review-smoke` | 測試 Figma 畫布工具會略過 auto-review 並直接轉送。 |
| `npm run bridge:permissions-smoke` | 測試自動審查的專案檔案寫入。 |
| `npm run bridge:selection-smoke` | 測試選取 metadata 與 local image input。 |
| `npm run codex:schema` | 產生目前實驗性 App Server TypeScript bindings。 |

## 專案結構

```text
bridge/                 Provider 探測／adapter、App Server client、bridge、skills、審查器
scripts/                常駐服務、token、schema、smoke tests
src/UI.svelte           外掛 iframe 與 Provider 隔離的 event/tool routing
src/code.ts             Figma sandbox、storage、選取擷取、工具執行
src/tools.ts            dynamic-tool schemas
src/system-prompt.md    Figma Agent 指令
src/components/         Svelte UI
skills/                 兩個 Provider 共用的 <name>/SKILL.md packages
test/                   unit 與 security-contract tests
public/                 Figma manifest 與產生的 build
docs/attribution/       保留的 FigClaw 上游宣傳素材
```

`public/` 內的產生檔案應透過 build 更新，不要手動編輯。

## 參與開發

Repository 的工程限制請先讀 [AGENTS.md](AGENTS.md)，本機開發流程請見 [CONTRIBUTING.md](CONTRIBUTING.md)。功能行為改變時，請同步更新英文與繁體中文文件。

## 來源與授權

FigCC 基於 Pavel Laptev 建立的 [PavelLaptev/FigClaw](https://github.com/PavelLaptev/FigClaw)。上游專案採 MIT License，原始版權聲明已完整保留。

FigCC 同樣以 [MIT License](LICENSE) 開源。完整來源標示與重大修改摘要請見 [NOTICE.md](NOTICE.md)。
