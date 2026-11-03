# 数据结构

## 公告的两种形态

- `announcements/*.md`：**作者写这个**。frontmatter 里是 date/level/title，正文是 body。
- `announcements.json`：官网与桌面端实际读取的产物，由 `build-announcements.mjs` 生成。

为什么不直接让前端读 Markdown：渲染 Markdown 就要引 Markdown 解析器（体积 + XSS 面），
而公告只需要"标题 + 一段纯文本"。所以把 Markdown 当**源格式**，JSON 当**发布格式**。

## 生成

```bash
node data/build-announcements.mjs
```

## latest.json

官网与桌面端用同一个文件显示“最新版本”。字段：`version` / `date` / `sizeText` / `download` / `notes` / `status`。
`download` 在公开发布前为 `null`；`status: "candidate-not-public"` 表示该版本是开发候选，不得包装成正式发布。
