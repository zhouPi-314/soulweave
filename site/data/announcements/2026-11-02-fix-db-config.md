---
date: 2026-11-02
level: fix
title: 修复：配置写入目标不一致
---

向导此前写 memory-db.json，而运行时读 db-connection.json，导致“显示就绪但记忆没连上”。现已统一。
