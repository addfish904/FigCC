---
name: ui-modification
description: "在既有 Figma 設計稿上做最小幅度修改：沿用現有 components、variables 與排列規則，只動需求涉及的區域。"
---

# Skill: UI Modification

在**既有設計稿**上依需求調整 UI 時套用本 skill。以現有設計稿為唯一視覺基準，只調整需求指定的內容，不重新設計整頁。

本 skill 不適用於從零開始的新畫面設計。

## 核心原則

- 現有設計稿是唯一視覺基準，不是參考建議。
- 只修改需求涉及的區域，不重構未涉及區域。
- 採最小幅度修改：能改一個屬性就不換元件，能換元件就不重畫。
- 不自行新增需求範圍外的功能、欄位或裝飾。

## 動手前必做：盤點

**在做任何修改之前**，先完成盤點。沒有盤點就動手，等於憑畫面猜樣式，會產出看起來像、實際沒綁 design system 的結果。

1. `get_selection` — 取得使用者選取的節點，這是修改範圍的中心。
2. `get_node_by_id` — 往上取父容器，往旁取同層兄弟節點。要從**鄰近欄位**歸納出實際的排列規則：欄寬、`itemSpacing`、對齊、label 與 input 的相對位置。
3. `get_components` — 盤點**整份檔案**的 components 與 component sets，確認有哪些可以直接 instantiate。
4. `get_variables` — 盤點**整份檔案**的 variable collections 與 modes。
5. `get_styles` — 盤點 text / paint / effect styles。

版面判斷只看選取範圍與其鄰近節點；可用元件與 token 則盤全檔，避免漏掉別的 page 已經做好的元件。

盤點結果要實際影響決策。若盤點後發現需求其實已有現成元件，直接用它，不要另建。

## 沿用既有樣式

- **元件**：優先 `instantiate` 既有 component，用 `setProperties()` 調 variant 與 component property，而不是新建節點。
- **間距**：沿用父容器既有的 `itemSpacing` 與 `padding`。若原本綁了 variable，新節點也必須綁同一個 variable，不要複製它當下的數值 — 複製數值會讓 token 之後改動時散掉。

  ```js
  const spacing = figma.variables.getVariableById(existingId);
  frame.setBoundVariable('itemSpacing', spacing);
  ```

- **文字**：套用既有 text style（`setTextStyleIdAsync`），不要手動設 `fontSize` / `fontName` / `lineHeight`。
- **顏色**：套用既有 paint style 或綁 color variable，不要寫死 hex。
- **grid / layout**：維持既有 `layoutMode`、`primaryAxisAlignItems`、`counterAxisAlignItems` 與 layout grid。不要為了塞新內容改變父容器的版面模式。

## 新增欄位

- 放進**語意上合理的資訊群組**，不是視覺上最空的地方。判斷依據是鄰近欄位在講什麼，不是哪裡有空位。
- 沿用現有的 input / select / checkbox component，含其所有 variant 設定（尺寸、狀態、是否有 helper text）。
- 維持該群組既有的欄位寬度與排列規則（單欄 / 雙欄、label 在上或在左）。
- 插入位置用 `parent.insertChild(index, node)` 明確指定，不要 append 到最後再搬。

## 移除欄位

- 移除後必須重新整理間距，不留不自然空白。
- 父容器是 auto layout（`layoutMode !== 'NONE'`）時，移除節點後間距會自動重排，**不要**再手動補位移。
- 父容器是絕對定位時，才需要把下方兄弟節點上移被移除節點的高度加 `itemSpacing`，並縮小父容器高度。
- 檢查移除後是否讓某個群組只剩一個項目、或整組空掉。若整組空掉，該群組的標題與容器也要一併處理，不要留下空殼。
- 不影響其他資訊層級：不因為少了一欄就把其他欄位改寬或改排列。

## UIUX 檢查

修改完成後逐項檢查：

- **對齊一致**：新增/調整的元素與同群組其他元素在同一基準線與欄位格線上。
- **label 關聯明確**：label 與其輸入元件的距離明顯小於它與鄰近欄位的距離，讓歸屬一眼可辨。
- **必填與選填標示**：與該表單既有的標示方式一致。
- **狀態齊備**：新增的互動元件要具備該 component 既有的狀態 variant（hover / focus / disabled / error），不要只放 default。
- **錯誤訊息位置**：與既有欄位的錯誤呈現方式一致。
- **閱讀與 tab 順序**：Figma 圖層順序即閱讀順序。插入新欄位後確認圖層順序符合視覺上的填寫順序。
- **資訊密度**：新增後該區塊沒有變得過度擁擠，也沒有因為移除而鬆散失衡。

對比度、字級下限、觸控目標尺寸請改用 `accessibility` skill，本 skill 不重複定義那些門檻。

## 沒有完全符合的元件時

不要新建 component，也不要停下來等指示。改用**最接近的既有元件**完成需求，並**必須在回報中標註這是妥協**。

標註要具體，說明三件事：

1. 用了哪個既有元件；
2. 它與需求的差距是什麼；
3. 建議的後續處理（補 variant、或確認可接受）。

範例：

> ⚠️ 需求要「可多選的下拉選單」，檔案內只有單選 `Select / Default`。已用該元件並在 label 標示可多選，但**元件本身不支援多選互動**。建議之後為 `Select` 補一個 `multi` variant。

沒有標註就等於謊報完成。妥協本身可以接受，隱瞞不行。

## 完成後回報

每次修改結束都要回報，讓修改範圍可被驗證：

- **改了什麼**：逐項列出節點名稱與具體變更。
- **沿用了什麼**：用到的既有 component、variable、style 名稱。
- **沒有動什麼**：明確指出需求鄰近但刻意未修改的區域。
- **妥協與待確認**：上一節的標註，以及任何需要使用者裁決的項目。

## Rules

- 盤點（`get_selection` + `get_components` + `get_variables` + `get_styles`）必須在任何 mutation 之前完成。
- 一律 instantiate 既有 component；不新建 component。
- 一律綁既有 variable / style；不寫死數值或 hex。
- 不修改需求未涉及的節點，即使發現它們有瑕疵 — 改為在回報中提出。
- auto layout 容器不手動設子節點座標。
- 用最接近元件替代時，必須標註妥協內容。
- 每次結束都要輸出「改了什麼 / 沿用了什麼 / 沒有動什麼 / 妥協」四段回報。
