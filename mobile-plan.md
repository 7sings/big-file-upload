# 📄 PLAN.md：移动端大文件管理与预览 UI 适配指南

## 1. 项目背景与设计目标
本项目旨在为现有的 PC 端大文件上传应用适配移动端体验。
* **业务定位**：移动端**仅专注于文件管理与预览**，不提供大文件上传能力（大文件上传留给 PC 端）。
* **UI/UX 风格**：采用 **Clean Modern Bento Style**（iOS / Vercel 极简风），使用 **Tailwind CSS** 进行响应式布局与样式控制。
* **支持的文件类型**：`video`（视频）、`image`（图片）、`audio`（音频）、`pdf`（PDF文档）、`txt`（文本文档）。

---

## 2. 视觉规范 (Design Tokens & Styles)

### 2.1 配色与质感
* **整体背景**：`bg-slate-50`
* **卡片背景**：`bg-white` + `rounded-2xl` + `shadow-sm` + `border border-slate-100`
* **交互反馈**：点击态 `active:scale-[0.98] transition-transform duration-150`

### 2.2 文件类型语义化配色卡 (File Type Theme Mapping)
针对 5 种支持的文件类型，统一使用标准的配色映射：
* **Video**：图标/文字 `text-indigo-600` | 浅背景 `bg-indigo-50` | 边框 `border-indigo-100`
* **Image**：图标/文字 `text-emerald-600` | 浅背景 `bg-emerald-50` | 边框 `border-emerald-100`
* **Audio**：图标/文字 `text-amber-600` | 浅背景 `bg-amber-50` | 边框 `border-amber-100`
* **PDF**：图标/文字 `text-rose-600` | 浅背景 `bg-rose-50` | 边框 `border-rose-100`
* **TXT**：图标/文字 `text-sky-600` | 浅背景 `bg-sky-50` | 边框 `border-sky-100`

---

## 3. 核心功能与页面结构布局 (Page Layout Structure)

整个移动端页面分为上下 4 个核心区域：

```
+-------------------------------------------------------+
|  1. 吸顶搜索栏 (Sticky Header & Search Bar)           |
+-------------------------------------------------------+
|  2. Bento 概览与提示卡 (Storage & Notice Banner)       |
+-------------------------------------------------------+
|  3. 文件类型横向滑动筛选 (Category Filter Tabs)        |
+-------------------------------------------------------+
|  4. 文件卡片列表与操作 (File Card List & Action Sheet) |
+-------------------------------------------------------+
```

### 区域 1：吸顶搜索栏 (Sticky Search Header)
* `sticky top-0 z-30 bg-slate-50/80 backdrop-blur-md px-4 py-3 border-b border-slate-200/50`
* 内置搜索输入框，支持根据文件名实时模糊匹配过滤。右侧带一键清空按钮 `(x)`。

### 区域 2：Bento 概览与 PC 上传提示卡 (Storage & Notice Banner)
* 使用双列 Bento 网格：
  * **左卡片**：显示存储状态（如：`128 个文件` / `42.5 GB 已用`）。
  * **右卡片**：浅色提示块，带电脑图标提示 `上传请使用 PC 端访问`。

### 区域 3：文件类型分类切片 (Category Pills)
* 横向滚动容器 `flex gap-2 overflow-x-auto no-scrollbar px-4 py-2`
* 分类节点：`全部 (All)` | `视频 (Video)` | `图片 (Image)` | `音频 (Audio)` | `PDF` | `文档 (TXT)`
* 选中态：`bg-slate-900 text-white`；未选中态：`bg-white text-slate-600 border border-slate-200`。

### 区域 4：文件卡片列表 (File Card Items)
每个文件卡片结构（`flex items-center justify-between p-3 bg-white rounded-2xl mb-3`）：
1. **左侧 48x48 缩略图/图标**：
   * 图片/视频：若是图片或带封面，显示 `object-cover rounded-xl` 的微缩图；
   * 其他：显示对应的语义化高亮图标及浅色背景卡片。
2. **中间文件信息**：
   * 文件名：`font-medium text-slate-800 truncate text-sm max-w-[180px]`
   * 状态/元信息：`text-xs text-slate-400 mt-0.5`（显示文件大小与修改时间，如 `1.2 GB · 2026-07-20`）。
3. **右侧操作组**：
   * 预览按钮（或直接点击卡片主体触发预览）。
   * 更多/删除按钮（点击拉起底部危险操作面板）。

---

## 4. 关键交互流程规范

### 4.1 底部操作与二次确认面板 (Delete Confirmation ActionSheet)
* **禁止使用原生 `window.confirm()`**。
* **流程**：点击删除 -> 触发底部弹出面板 (Action Sheet)。
* **面板内容**：
  * 警告图标与标红文件名。
  * 警告提示：“确定要彻底删除该文件吗？此操作无法撤销。”
  * 确认删除按钮（红色 `bg-rose-600 text-white font-medium`），建议增加 `0.3s` 的点击防误触机制。
  * 取消按钮（灰色 `bg-slate-100 text-slate-700`）。

### 4.2 预览逻辑模态框 (Preview Modal/Drawer)
* **图片 (Image)**：全屏黑底 Lightbox 弹窗，支持全屏预览与手势关闭。
* **视频 (Video)**：支持 HTML5 `<video controls>` 原生全屏播放。
* **音频 (Audio)**：底部浮动 Mini 播放条 (`fixed bottom-4 left-4 right-4 bg-slate-900 text-white p-3 rounded-2xl shadow-xl`)。
* **PDF / TXT**：弹出模态框显示文档内容（TXT 自动解析文本，PDF 引导新标签页打开或 Canvas 预览）。

---

## 5. Codex 执行代码生成指令 (Prompt for Code Agent)

```text
请严格按照上面的规范，使用 React / Next.js + Tailwind CSS + Lucide Icons，实现移动端文件管理 UI 组件。要求移动端的页面新写一套，api和逻辑可以复用之前的。根据浏览器的ui自动切换到移动端的ui

【核心要求】：
1. 参照 PLAN.md 中的 Tailwind CSS 样式定义与 Semantic Color Scheme。
2. 实现完整的移动端布局：
   - 1. 吸顶毛玻璃搜索框（含实时搜索 State）
   - 2. Bento 风格存储概览 & PC 端上传提示卡
   - 3. 可横向滑动的 6 种文件类型分类切片 (Filter Pills)
   - 4. 文件列表（支持 Icon 与图片微缩图）
3. 交互实现：
   - 点击文件卡片支持触发 Preview Modal（图片/视频/音频/PDF/TXT 分别做简易 Mock 响应）。
   - 点击文件项右侧删除图标，弹出优雅的底部危险确认 Action Sheet，阻止误触。
4. 响应式与体验优化：
   - 使用 flex/grid 布局，严格保证在 iPhone / Android 屏幕宽度的兼容性。
   - 隐藏滚动条 (no-scrollbar)，使用 iOS 风格大圆角 (rounded-2xl) 和轻微阴影 (shadow-sm)。

```