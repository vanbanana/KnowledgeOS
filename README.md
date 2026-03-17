# KnowledgeOS

KnowledgeOS 是一个基于 Tauri、React、TypeScript、Rust、SQLite 与 Python parser worker 的本地优先知识工作台。

## 当前阶段

当前仓库已完成桌面壳与数据底座的首批工程初始化，对应 `knowledgeos_ai_dev_tasks.md` 中的 `TASK-000 ~ TASK-015` 范围：

- monorepo 与目录规范
- Tauri + React + TypeScript 桌面应用骨架
- shared-types 共享契约包
- 配置与日志系统
- SQLite 初始化与迁移
- Project Service
- 项目目录生成器
- 本地 Job Queue
- typed commands 骨架
- Python parser worker 最小骨架

## 目录结构

```text
apps/desktop            Tauri + React 桌面应用
packages/shared-types   共享类型、Zod schema、命令契约
workers/parser          Python parser worker 最小骨架
fixtures/documents      文档回归样本目录
docs/tasks              任务拆解文档目录
```

## 常用命令

```bash
pnpm install
pnpm dev
pnpm tauri:dev
pnpm lint
pnpm typecheck
pnpm test
```

## 说明

- 当前不使用 Electron。
- Rust 侧优先采用 `rusqlite`，目标是简单稳定。
- Python worker 目前只提供健康检查与 mock 解析响应，后续承接 `TASK-022 ~ TASK-028`。

