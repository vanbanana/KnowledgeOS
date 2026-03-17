# KnowledgeOS AI 开发任务列表（Tauri / Rust 优先版）

> 依据《KnowledgeOS 开发架构需求 PRD》拆解。
> 目标：产出一份适合 **纯 AI 开发** 的、可顺序执行也可并行分发的任务清单。
> 结论先行：**不建议先用 Electron 做正式 MVP 再整体重写到 Tauri/Rust**。更合适的方案是：**从 Day 1 就使用 Tauri + React + TypeScript + Rust 起壳**，但把 Rust 控制在“壳、数据库、任务编排、安全边界、导出”这几个高价值层，复杂文档解析先交给 Python sidecar / worker。

---

## 1. 开发策略结论

### 1.1 推荐路线

采用 **Tauri-first, Rust-thin-core, Python-worker, React-UI**：

- **桌面壳**：Tauri
- **前端**：React + TypeScript
- **核心能力**：Rust（命令、数据库、任务队列、文件系统沙盒、快照/回滚、导出）
- **文档解析**：Python sidecar（PDF / PPTX / DOCX / 资产提取 / 标准化）
- **AI 接入**：先走 OpenAI-compatible / 云模型，后续可补本地模型适配
- **存储**：SQLite + 本地文件系统 + 本地向量索引

### 1.2 为什么不建议“先 Electron，后重写”

对纯 AI 开发来说，二次重写的隐性成本很高：

- AI 在第一次开发时形成的模块边界，重写时很容易漂移
- Electron -> Tauri 不是简单替换，涉及 IPC、文件权限、进程模型、打包方式、sidecar、安全模型的整体变化
- 第二次重写会把测试、验收脚本、调试脚本、CI 和安装流程一起重做
- 你真正关心的“流畅度”和“本地安全边界”恰好是 Tauri 的优势区，不值得等到第二版再迁移

### 1.3 折中方案

不是“纯 Rust 一把梭”，而是：

- **先上 Tauri**，避免未来整体迁移
- **先薄写 Rust**，降低 AI 编码复杂度
- **先把文档解析放 Python**，利用成熟生态
- **所有复杂能力都走显式协议**，以后再逐步把 Python 模块替换成 Rust

---

## 2. 适合纯 AI 开发的工程原则

### 2.1 一个任务必须满足 6 个条件

每个任务都必须：

1. 有明确输入和输出
2. 修改文件范围可控
3. 能独立通过验收命令验证
4. 尽量不跨多个子系统同时重构
5. 失败后容易回退
6. 能单独提交、单独评审

### 2.2 AI 开发任务的粒度原则

- 单任务目标尽量只解决 **一个可验证能力**
- 单任务尽量只动 **1~3 个模块**
- 每个任务都要附带：
  - 修改目标
  - 关键文件
  - 依赖任务
  - 验收标准
  - 推荐提示词

### 2.3 研发节奏建议

建议采用 3 层节奏：

- **L1 基础底座层**：项目结构、数据库、IPC、队列、日志
- **L2 核心能力层**：导入、标准化、切块、解读、搜索、图谱、Agent
- **L3 体验层**：阅读器交互、图谱交互、导出、设置、性能优化

### 2.4 AI 开发执行规则

- 不允许 AI 在未完成 schema / interface 的情况下直接乱改 UI
- 不允许 AI 跳过测试直接堆功能
- 不允许 AI 在同一任务中同时修改数据库结构、IPC 契约和 3 个页面
- 所有核心模块先写契约，再写实现，再写 UI 接入

---

## 3. 推荐仓库结构

```text
knowledgeos/
  apps/
    desktop/                  # Tauri + React 应用
      src/
      src-tauri/
  packages/
    shared-types/             # TS 类型、Zod schema、命令契约
    prompt-templates/         # Prompt 模板与 JSON schema
    ui/                       # 可复用 UI 组件
  workers/
    parser/                   # Python 文档解析 worker
  scripts/
  fixtures/
    documents/                # 回归样本文档
  docs/
    prd/
    architecture/
    tasks/
```

---

## 4. 建议的技术基线

### 4.1 MVP 技术栈

- Tauri
- React + TypeScript
- Zustand
- TanStack Query
- Rust + SQLx / rusqlite（二选一，优先简单稳定）
- SQLite
- Python parser worker
- Markdown 渲染组件
- 图谱可视化组件
- Zod / JSON Schema

### 4.2 MVP 只让 Rust 负责这些事

Rust 负责：

- Tauri commands
- SQLite 访问
- Job queue
- 文件路径沙盒
- 快照/回滚
- 导出
- sidecar 调度
- 配置和日志

Rust 暂时不负责：

- 复杂 PDF 解析
- 复杂自然语言处理
- 高级 OCR
- 复杂图谱布局算法

---

## 5. 任务编排方式

### 5.1 任务状态

- `todo`
- `doing`
- `blocked`
- `review`
- `done`

### 5.2 优先级

- `P0`：MVP 必须
- `P1`：MVP 强烈建议
- `P2`：V1 再做

### 5.3 任务字段模板

后续所有任务统一使用下面格式：

```md
## TASK-ID 标题
- status: todo
- priority: P0
- owner: ai
- depends_on: []
- goal:
- scope:
- deliverables:
- files:
- acceptance:
- prompt_hint:
```

---

## 6. 总执行顺序

```text
Phase 0 基础工程
  -> Phase 1 数据与项目系统
  -> Phase 2 导入与标准化
  -> Phase 3 切块与阅读器
  -> Phase 4 Explain / Card / Search
  -> Phase 5 Graph
  -> Phase 6 Agent / 安全 / 回滚
  -> Phase 7 导出 / 设置 / 稳定性 / 测试
```

---

# 7. 详细任务列表

## Phase 0：基础工程与技术骨架

### TASK-000 初始化 monorepo 与目录规范
- status: done
- priority: P0
- owner: ai
- depends_on: []
- goal: 创建 monorepo 目录结构，包含 apps、packages、workers、fixtures、docs。
- scope: 仓库结构、根 package 管理、基础 README。
- deliverables:
  - monorepo 初始化完成
  - 根目录脚本可运行
  - 基础 README 与目录说明
- files:
  - package.json
  - pnpm-workspace.yaml
  - README.md
  - apps/
  - packages/
  - workers/
- acceptance:
  - `pnpm install` 成功
  - 根目录 `pnpm lint` / `pnpm typecheck` 不报错
- prompt_hint: 创建一个适合 Tauri + React + Rust + Python worker 的 monorepo，提供可扩展目录结构和基础脚本。

### TASK-001 初始化 Tauri 桌面应用
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-000]
- goal: 创建 Tauri 桌面应用，前端使用 React + TypeScript。
- scope: 仅完成可启动壳，不接业务逻辑。
- deliverables:
  - Tauri 应用可启动
  - React 页面可渲染
  - Rust 命令 hello world 可调用
- files:
  - apps/desktop/src-tauri/*
  - apps/desktop/src/*
- acceptance:
  - `pnpm tauri dev` 可启动桌面应用
  - 前端可调用一个示例 Tauri command
- prompt_hint: 用 Tauri 搭一个最小桌面应用，保留未来接入 typed commands 的结构。

### TASK-002 建立代码规范与 CI 基础
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-000, TASK-001]
- goal: 建立 TS、Rust、Python 三端的格式化、lint、typecheck 和最小 CI。
- scope: 工程质量基础。
- deliverables:
  - TS lint / typecheck
  - Rust fmt / clippy
  - Python lint / format（可先最小化）
  - CI 脚本
- files:
  - .github/workflows/*
  - apps/desktop/package.json
  - workers/parser/requirements.txt 或 pyproject.toml
- acceptance:
  - CI 可执行最小校验
  - 本地一条命令跑完基础检查
- prompt_hint: 为 monorepo 增加 TS、Rust、Python 的统一开发质量脚本与最小 CI。

### TASK-003 设计 shared-types 与命令契约包
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-001]
- goal: 建立 shared-types 包，统一前端状态、命令输入输出、DTO 和 schema。
- scope: 类型与契约，不写实际业务。
- deliverables:
  - Command DTO 定义
  - Project / Document / Block / Card / Task 基础类型
  - Zod schema
- files:
  - packages/shared-types/*
- acceptance:
  - 前端与 Rust 命令层都能引用相同的接口定义说明
  - 基础 schema 能跑单测
- prompt_hint: 为 KnowledgeOS 设计一套面向 Tauri commands 的共享类型和 schema。

### TASK-004 建立应用配置与日志系统
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-001]
- goal: 建立本地配置加载、日志目录和分层日志记录能力。
- scope: app log、parse log、model log、agent log、audit log。
- deliverables:
  - 配置加载器
  - 本地日志目录初始化
  - 基础日志 API
- files:
  - apps/desktop/src-tauri/src/config/*
  - apps/desktop/src-tauri/src/logging/*
- acceptance:
  - 应用启动自动创建日志目录
  - 前端触发命令后能写入 app log
- prompt_hint: 在 Tauri/Rust 侧实现本地配置与分层日志。

---

## Phase 1：项目系统、数据库与任务底座

### TASK-010 初始化 SQLite 与迁移机制
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-001, TASK-003]
- goal: 建立 SQLite 数据库、迁移机制和基础连接层。
- scope: 只做基础，不上业务逻辑。
- deliverables:
  - app.db 初始化
  - migration 机制
  - Rust DB access 封装
- files:
  - apps/desktop/src-tauri/src/db/*
  - apps/desktop/src-tauri/migrations/*
- acceptance:
  - 应用首次启动自动创建数据库
  - 迁移命令可重复执行
- prompt_hint: 实现 KnowledgeOS 的 SQLite 初始化和 migration 机制。

### TASK-011 建立核心表结构 v1
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-010]
- goal: 创建 MVP 核心数据表。
- scope: projects、documents、blocks、block_explanations、cards、graph_nodes、graph_relations、agent_tasks、task_logs、snapshots、settings、jobs。
- deliverables:
  - 所有核心表创建完成
  - 基础索引建立完成
- files:
  - migrations/*.sql
- acceptance:
  - 数据库中可看到所有表和必要索引
  - migration 单测通过
- prompt_hint: 根据 PRD 建立 MVP 核心 SQLite schema 和索引。

### TASK-012 建立 Project Service
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-010, TASK-011]
- goal: 支持创建项目、打开项目、列出项目、删除项目。
- scope: Project 的 CRUD 与本地目录初始化。
- deliverables:
  - createProject / openProject / listProjects 命令
  - project_root 目录初始化逻辑
- files:
  - src-tauri/src/services/project/*
- acceptance:
  - 可通过 UI 创建并打开项目
  - 项目目录结构自动生成
- prompt_hint: 为 KnowledgeOS 实现 Project Service 和本地目录初始化。

### TASK-013 建立本地目录布局生成器
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-012]
- goal: 在创建项目时自动创建 source / normalized / assets / blocks / cards / exports / snapshots / logs / temp 目录。
- scope: 只管目录与路径工具。
- deliverables:
  - 路径生成函数
  - 安全路径解析器
- files:
  - src-tauri/src/fs/*
- acceptance:
  - 新建项目后目录结构完整可见
  - 所有路径均限定在 project_root 内
- prompt_hint: 实现 project_root 受控目录结构和路径助手函数。

### TASK-014 建立 Job Queue 基础设施
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-010, TASK-011]
- goal: 为解析、切块、索引、Explain、导出等耗时任务建立本地持久化队列。
- scope: 队列骨架，不接复杂业务。
- deliverables:
  - jobs 表与状态机
  - enqueue / run / cancel / retry 基础 API
- files:
  - src-tauri/src/jobs/*
- acceptance:
  - 能创建一个 mock job 并消费执行
  - UI 能查看 job 状态
- prompt_hint: 用 Rust 实现一个本地持久化任务队列，支持 pending/running/succeeded/failed/cancelled。

### TASK-015 建立 Typed Commands 骨架
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-003, TASK-012, TASK-014]
- goal: 为前端到 Rust 的所有命令建立 typed invoke 封装。
- scope: 只建立统一调用框架。
- deliverables:
  - invoke wrapper
  - 错误类型统一
  - 基础命令注册
- files:
  - apps/desktop/src/lib/commands/*
  - src-tauri/src/commands/*
- acceptance:
  - 前端能通过统一命令层调用 Rust 命令
  - 错误能标准化返回
- prompt_hint: 设计 Tauri command 的类型安全封装，避免前端直接散乱 invoke。

---

## Phase 2：导入、标准化与解析 worker

### TASK-020 设计文档导入流程与状态机
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-012, TASK-014, TASK-015]
- goal: 设计 imported -> parsing -> normalized -> chunked -> indexed -> ready -> failed 的状态流转。
- scope: Document 状态管理。
- deliverables:
  - Document 状态机
  - importFiles 命令骨架
- files:
  - src-tauri/src/services/import/*
- acceptance:
  - 导入时状态会变化并持久化
  - 失败状态可记录原因
- prompt_hint: 为导入与标准化设计一套可持久化的文档状态机。

### TASK-021 文档注册与去重
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-020]
- goal: 导入文件时按 source_hash 去重，写入 documents 表。
- scope: 文件哈希、元数据登记、重复导入识别。
- deliverables:
  - file hash 计算
  - documents 记录创建
  - 重复导入策略
- files:
  - src-tauri/src/services/import/*
- acceptance:
  - 重复导入同一文件不会重复生成多份 document
- prompt_hint: 实现文档导入登记与基于 source_hash 的去重机制。

### TASK-022 设计 Python parser sidecar 通信协议
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-001, TASK-020]
- goal: 定义 Rust <-> Python parser worker 的命令协议、输入输出 JSON、错误码和超时机制。
- scope: 只做协议和 sidecar 启动管理。
- deliverables:
  - parser request/response schema
  - sidecar 生命周期管理
  - 超时与错误处理
- files:
  - packages/shared-types/*
  - workers/parser/*
  - src-tauri/src/sidecar/*
- acceptance:
  - Rust 能调用 Python worker 并收到结构化响应
- prompt_hint: 定义 Tauri/Rust 与 Python parser worker 的 JSON 协议和 sidecar 管理器。

### TASK-023 搭建 parser worker 基础骨架
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-022]
- goal: 创建 Python parser worker，可接收命令、解析文件并返回标准化结果框架。
- scope: 先实现基础 server/cli，不做完整解析。
- deliverables:
  - worker 入口
  - parse_file 命令
  - 健康检查命令
- files:
  - workers/parser/*
- acceptance:
  - worker 可被 sidecar 调起
  - 输入文件路径，返回 mock markdown + manifest
- prompt_hint: 实现一个可被 Tauri sidecar 调起的 Python parser worker。

### TASK-024 实现 Markdown / TXT 标准化
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-023]
- goal: 优先实现最容易的 MD/TXT 标准化，打通端到端流程。
- scope: 清洗、标题结构识别、manifest 生成。
- deliverables:
  - md/txt parser
  - manifest 生成器
- files:
  - workers/parser/parsers/md_txt.py
- acceptance:
  - 导入 MD/TXT 后能生成 normalized markdown 和 manifest
- prompt_hint: 先实现 MD/TXT 的标准化，作为最小可用解析链路。

### TASK-025 实现 PDF 标准化 v1
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-023]
- goal: 支持文本型 PDF 解析，输出保留页码、标题近似结构、图片占位和基本 manifest。
- scope: 文本型 PDF 优先，不做重 OCR。
- deliverables:
  - pdf parser
  - page anchor 输出
  - 低质量解析告警
- files:
  - workers/parser/parsers/pdf.py
- acceptance:
  - 典型文本 PDF 能转成 markdown
  - manifest 中包含 page anchors
- prompt_hint: 实现文本型 PDF -> Markdown + manifest 的 MVP 解析器。

### TASK-026 实现 PPTX 标准化 v1
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-023]
- goal: 每页幻灯片转为 markdown section，保留 slide_index、标题、主体内容、图片占位。
- scope: PPTX 优先，不追求复杂动画。
- deliverables:
  - pptx parser
  - slide anchors
- files:
  - workers/parser/parsers/pptx.py
- acceptance:
  - PPTX 导入后能生成按 slide 划分的 markdown
- prompt_hint: 把 PPTX 每页转成 markdown section，并输出 slide_index anchor。

### TASK-027 实现 DOCX 标准化 v1
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-023]
- goal: 保留标题层级、段落、列表、表格弱表示、图片引用。
- scope: DOCX 基础结构抽取。
- deliverables:
  - docx parser
  - heading hierarchy 输出
- files:
  - workers/parser/parsers/docx.py
- acceptance:
  - 常见 DOCX 能转 markdown
- prompt_hint: 实现 DOCX 的基础结构抽取，输出可切块 markdown。

### TASK-028 标准化结果写盘与 manifest 管理
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-024, TASK-025, TASK-026, TASK-027]
- goal: 将标准化结果统一写入 normalized/docs、normalized/manifests、assets。
- scope: 文件写盘与 DB 状态更新。
- deliverables:
  - markdown writer
  - manifest writer
  - asset writer
- files:
  - src-tauri/src/services/normalize/*
- acceptance:
  - 每份解析成功文档都能在本地目录看到规范输出
- prompt_hint: 把 parser worker 返回结果统一写入项目标准目录并更新 document 状态。

---

## Phase 3：切块引擎与阅读器 MVP

### TASK-030 设计 Block 数据结构与块状态
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-011, TASK-028]
- goal: 明确 Block 的字段、层级、排序和来源锚点。
- scope: 只做结构设计与落库支持。
- deliverables:
  - Block DTO
  - blocks 表写入接口
- files:
  - packages/shared-types/*
  - src-tauri/src/services/block/*
- acceptance:
  - 可从 normalized 文档生成 Block 对象并写入数据库
- prompt_hint: 为 Block-first 架构定义稳定的 Block 数据模型与落库接口。

### TASK-031 实现结构切块引擎 v1
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-030]
- goal: 基于标题、页码/slide、段落、图表块、表格块做第一阶段结构切块。
- scope: 先不做语义重平衡。
- deliverables:
  - structure chunker
  - 块顺序与层级输出
- files:
  - src-tauri/src/services/chunk/structure_chunker.rs
- acceptance:
  - 一份标准化文档可生成有顺序的 blocks
- prompt_hint: 基于标题与锚点实现文档结构切块引擎。

### TASK-032 实现语义修整与块大小控制
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-031]
- goal: 对过大块做拆分，对过小块做合并，控制可读性和 AI 输入长度。
- scope: 启发式规则优先。
- deliverables:
  - rebalancer
  - token estimate
- files:
  - src-tauri/src/services/chunk/rebalance.rs
- acceptance:
  - 块大小分布明显优于纯结构切块
- prompt_hint: 实现一个基于 token 长度和段落边界的 Block rebalancer。

### TASK-033 设计稳定 block_id 算法
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-031, TASK-032]
- goal: 基于 document_id + heading_path + source_anchor + content_hash 生成稳定 block_id。
- scope: 稳定性与重复导入一致性。
- deliverables:
  - block id 生成器
  - 稳定性单测
- files:
  - src-tauri/src/services/chunk/block_id.rs
- acceptance:
  - 文档未实质变更时，重复切块后的 block_id 保持稳定
- prompt_hint: 为 Block 设计尽量稳定的 ID 生成算法并补测试。

### TASK-034 切块结果写盘与索引
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-031, TASK-032, TASK-033]
- goal: 将块结果写入 DB 和 blocks/{document_id}.jsonl。
- scope: 数据持久化与状态更新。
- deliverables:
  - block writer
  - chunked 状态更新
- files:
  - src-tauri/src/services/chunk/*
- acceptance:
  - blocks 表和 blocks jsonl 同时可用
- prompt_hint: 把切块结果可靠地落到 SQLite 和本地文件。

### TASK-035 阅读器主布局 UI
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-034, TASK-015]
- goal: 完成左目录、中间 Block、右侧解释面板的三栏阅读器。
- scope: 先完成最小交互。
- deliverables:
  - Block tree
  - current block view
  - right panel 占位
- files:
  - apps/desktop/src/pages/reader/*
- acceptance:
  - 能浏览文档块并切换当前 block
- prompt_hint: 用 React 做一个 Block-first 阅读器，左树中内容右三栏布局。

### TASK-036 原文锚点回跳与阅读器状态恢复
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-035]
- goal: 支持从 Block 回到原文位置，并在重新打开项目时恢复上次阅读位置。
- scope: anchor mapping 与 local view state。
- deliverables:
  - jump to source anchor
  - last read block restore
- files:
  - apps/desktop/src/pages/reader/*
  - src-tauri/src/services/reader_state/*
- acceptance:
  - 关闭重开项目后能恢复到上次 block
- prompt_hint: 为阅读器增加 source anchor 回跳与 last-read 恢复。

### TASK-037 Block 收藏与基础注释
- status: done
- priority: P1
- owner: ai
- depends_on: [TASK-035]
- goal: 支持 block 收藏、简单用户注释。
- scope: 最小读写。
- deliverables:
  - favorite 标记
  - note 字段或独立表
- files:
  - blocks / annotations 相关表和 UI
- acceptance:
  - 用户可收藏和备注 block
- prompt_hint: 为 Block 增加最小收藏和注释能力。

---

## Phase 4：Explain、Card 与搜索

### TASK-040 设计 Model Adapter 接口
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-003, TASK-015]
- goal: 统一块级解释、关系建议、Agent plan 等模型调用入口。
- scope: 先做接口，不耦合具体供应商。
- deliverables:
  - model request/response schema
  - provider abstraction
- files:
  - src-tauri/src/ai/model_adapter/*
- acceptance:
  - 可以插入一个 mock provider
- prompt_hint: 设计一个统一的 Model Adapter，为未来云模型与本地模型预留接口。

### TASK-041 定义 Explain JSON schema 与 prompt 模板
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-040]
- goal: 固化块级解释的 JSON 输出格式和 prompt 版本管理。
- scope: 只做 schema 与模板。
- deliverables:
  - explanation schema
  - prompt templates
  - prompt version 常量
- files:
  - packages/prompt-templates/*
  - packages/shared-types/*
- acceptance:
  - schema 校验单测通过
- prompt_hint: 根据 PRD 为 block explanation 设计结构化 JSON schema 与 prompt 模板。

### TASK-042 Explain Service 基础实现
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-041, TASK-034]
- goal: 给定 block_id 和 mode，生成结构化 explanation。
- scope: 只做默认模式与最小缓存。
- deliverables:
  - explainBlock command
  - explanation 持久化
  - 失败重试基础逻辑
- files:
  - src-tauri/src/services/explain/*
- acceptance:
  - 调用 explainBlock 后能得到结构化 JSON 并写入 DB
- prompt_hint: 实现 Block Explain Service，输出结构化 JSON 并写入 block_explanations 表。

### TASK-043 Explain 缓存与重算
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-042]
- goal: 按 block_id + mode + model + prompt_version 做缓存 key，支持重算。
- scope: 缓存命中和 invalidate。
- deliverables:
  - cache key
  - regenerate API
- files:
  - src-tauri/src/services/explain/*
- acceptance:
  - 相同参数重复请求优先返回缓存
  - 用户可触发重算
- prompt_hint: 为 Explain Service 增加可控缓存和重新生成。

### TASK-044 阅读器接入 Explain 面板
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-042, TASK-035]
- goal: 在右侧面板展示 summary、concepts、pitfalls、prerequisites、examples。
- scope: 最小展示与加载状态。
- deliverables:
  - explain panel
  - loading / error / retry UI
- files:
  - apps/desktop/src/components/explain/*
- acceptance:
  - 阅读器中可生成并查看块级解释
- prompt_hint: 把结构化 explanation 接到阅读器右侧面板中。

### TASK-045 Card Service 基础实现
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-042]
- goal: 支持从 block 或 explanation 保存为卡片。
- scope: create/read/update 最小功能。
- deliverables:
  - saveCard command
  - cards 表 CRUD
- files:
  - src-tauri/src/services/card/*
- acceptance:
  - 可从 block / explanation 一键生成 card
- prompt_hint: 实现 Card Service，支持来源回溯到 block 和 explanation。

### TASK-046 Card UI 与标签
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-045]
- goal: 提供卡片列表、卡片详情、基础标签编辑。
- scope: MVP 最小卡片库。
- deliverables:
  - card list
  - card detail
  - tag editor
- files:
  - apps/desktop/src/pages/cards/*
- acceptance:
  - 用户能浏览、编辑卡片并打标签
- prompt_hint: 实现卡片库页面与最小标签能力。

### TASK-047 建立全文搜索（SQLite FTS）
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-011, TASK-034, TASK-045]
- goal: 支持 documents / blocks / cards 的关键词全文搜索。
- scope: FTS 优先。
- deliverables:
  - FTS 表
  - search command
  - snippet 返回
- files:
  - migrations/*
  - src-tauri/src/services/search/*
- acceptance:
  - 输入关键词可返回 block/card/document 搜索结果
- prompt_hint: 用 SQLite FTS 为 documents/blocks/cards 实现全文搜索。

### TASK-048 建立向量索引抽象层
- status: done
- priority: P1
- owner: ai
- depends_on: [TASK-045]
- goal: 为 block / card / concept embeddings 定义向量接口和本地索引抽象。
- scope: 先做抽象与占位实现。
- deliverables:
  - embedding interface
  - vector index abstraction
- files:
  - src-tauri/src/services/vector/*
- acceptance:
  - 能插入 mock embedding 与 mock query
- prompt_hint: 先实现本地向量索引抽象，后续再接真实 embedding provider。

### TASK-049 混合搜索（FTS + semantic）
- status: done
- priority: P1
- owner: ai
- depends_on: [TASK-047, TASK-048]
- goal: 支持关键词与语义混合检索，并返回跳转目标。
- scope: MVP 基础融合排序。
- deliverables:
  - hybrid search API
  - result ranking
- files:
  - src-tauri/src/services/search/*
- acceptance:
  - 搜索结果包含 entity_type、entity_id、snippet、source、jump target
- prompt_hint: 实现一个轻量 hybrid search，把 FTS 与向量召回合并排序。

---

## Phase 5：Graph

### TASK-050 设计图谱节点与关系模型
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-011, TASK-045]
- goal: 定义 GraphNode / GraphRelation 的 MVP 模型，主节点以 card / concept / topic / document 为主。
- scope: 不让 block 默认直接上主图。
- deliverables:
  - graph DTO
  - relation types
- files:
  - packages/shared-types/*
  - src-tauri/src/services/graph/*
- acceptance:
  - 能创建 graph nodes 与 graph relations
- prompt_hint: 按 PRD 设计低噪声图谱数据模型，主节点不是全量 blocks。

### TASK-051 卡片到图谱节点映射
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-050]
- goal: 当创建 card 时自动生成或更新对应 graph node。
- scope: card -> node 绑定。
- deliverables:
  - node sync logic
- files:
  - src-tauri/src/services/graph/*
- acceptance:
  - 创建 card 后图谱里能看到相应节点
- prompt_hint: 为 Card Service 增加 card 与 graph node 的同步逻辑。

### TASK-052 关系建议基础管线
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-050, TASK-051, TASK-042]
- goal: 基于 explanation 中的 related_candidates 和规则，生成待确认的关系建议。
- scope: 不追求复杂推理。
- deliverables:
  - suggestRelations command
  - AI suggestion + rule suggestion 合流
- files:
  - src-tauri/src/services/graph/suggest.rs
- acceptance:
  - 系统可给出待确认关系建议
- prompt_hint: 根据 explanation.related_candidates 和规则生成图谱关系建议。

### TASK-053 图谱查询与过滤 API
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-050]
- goal: 提供按项目、文档、主题、节点类型过滤的子图查询能力。
- scope: 后端 API。
- deliverables:
  - getSubgraph command
  - graph filters
- files:
  - src-tauri/src/services/graph/query.rs
- acceptance:
  - 前端可获取可视化子图数据
- prompt_hint: 为图谱页面实现可过滤的子图查询接口。

### TASK-054 图谱页面 MVP
- status: done
- priority: P0
- owner: ai
- depends_on: [TASK-053]
- goal: 提供节点展示、搜索、过滤、点击详情和跳回 source block。
- scope: 先做中等规模图。
- deliverables:
  - graph page
  - node detail
  - jump to block
- files:
  - apps/desktop/src/pages/graph/*
- acceptance:
  - 用户能浏览图谱并从节点返回来源 block
- prompt_hint: 实现一个围绕 card/concept/topic 的 MVP 图谱页面。

### TASK-055 手动关系编辑
- status: done
- priority: P1
- owner: ai
- depends_on: [TASK-054]
- goal: 支持新增、删除、确认建议关系。
- scope: 手动编辑最小能力。
- deliverables:
  - add/remove/confirm relation UI
- files:
  - graph service + graph UI
- acceptance:
  - 用户可手动加边删边和确认建议边
- prompt_hint: 为图谱增加手动关系编辑与建议确认。

---

## Phase 6：Agent、安全、快照与回滚

### TASK-060 定义 AgentTask schema 与状态机
- status: todo
- priority: P0
- owner: ai
- depends_on: [TASK-011]
- goal: 建立 drafted / planned / awaiting_approval / executing / completed / failed / rolled_back / cancelled 状态机。
- scope: Agent 基础对象。
- deliverables:
  - agent task schema
  - status transitions
- files:
  - packages/shared-types/*
  - src-tauri/src/services/agent/*
- acceptance:
  - agent_tasks 表能管理完整生命周期
- prompt_hint: 定义 AgentTask 的状态机和数据模型。

### TASK-061 设计 Tool Registry（白名单工具）
- status: todo
- priority: P0
- owner: ai
- depends_on: [TASK-060]
- goal: 只开放 read_project_tree、read_document、rename_file、move_file、update_markdown、merge_cards、update_tags、create_relation、remove_relation、export_project 等白名单工具。
- scope: 明确工具接口与权限边界。
- deliverables:
  - tool registry
  - tool DTO
- files:
  - src-tauri/src/services/agent/tools/*
- acceptance:
  - Agent 无法调用未注册工具
- prompt_hint: 为 Agent 实现白名单工具注册表，不允许任意 shell。

### TASK-062 路径沙盒与文件权限控制
- status: todo
- priority: P0
- owner: ai
- depends_on: [TASK-061, TASK-013]
- goal: 所有写操作限定在 project_root 内，拒绝路径穿越。
- scope: 文件安全底座。
- deliverables:
  - safe path resolver
  - sandbox checks
- files:
  - src-tauri/src/fs/sandbox.rs
- acceptance:
  - 任何 project_root 外路径请求都被拒绝
- prompt_hint: 实现 project_root 级别的路径沙盒和路径穿越防护。

### TASK-063 Snapshot Manager
- status: todo
- priority: P0
- owner: ai
- depends_on: [TASK-011, TASK-062]
- goal: 在 destructive action 前创建快照。
- scope: 文件、Card、Relation 三类对象。
- deliverables:
  - snapshot create API
  - snapshot metadata
- files:
  - src-tauri/src/services/snapshot/*
- acceptance:
  - rename/move/update/merge 前自动生成快照
- prompt_hint: 实现快照系统，为 Agent 的可回滚执行做基础。

### TASK-064 Rollback Manager
- status: todo
- priority: P0
- owner: ai
- depends_on: [TASK-063]
- goal: 支持按 task_id 回滚最近一次或指定任务，并触发索引修复。
- scope: 文件与数据对象恢复。
- deliverables:
  - rollback API
  - rollback log
- files:
  - src-tauri/src/services/rollback/*
- acceptance:
  - 执行后可恢复文件和相关 DB 状态
- prompt_hint: 为 Agent 执行实现按 task_id 回滚，并补充索引修复逻辑。

### TASK-065 Agent Planner 协议与输出 schema
- status: todo
- priority: P0
- owner: ai
- depends_on: [TASK-040, TASK-060, TASK-061]
- goal: 设计 agent plan JSON，明确步骤、工具、受影响对象、风险级别。
- scope: 只做 plan schema 与 prompt。
- deliverables:
  - plan schema
  - preview schema
  - planner prompt
- files:
  - packages/prompt-templates/*
  - packages/shared-types/*
- acceptance:
  - plan 可被 schema 校验
- prompt_hint: 为本地知识 Agent 设计结构化 plan 和 preview schema。

### TASK-066 Agent Planner 基础实现
- status: todo
- priority: P0
- owner: ai
- depends_on: [TASK-065]
- goal: 用户输入任务文本后，先生成 plan，不直接执行。
- scope: planner 只输出结构化任务计划。
- deliverables:
  - planAgentTask command
  - plan 持久化
- files:
  - src-tauri/src/services/agent/planner.rs
- acceptance:
  - 输入自然语言任务后返回可展示的结构化 plan
- prompt_hint: 实现 Agent Planner，只生成 plan，不直接执行工具。

### TASK-067 Preview Generator
- status: todo
- priority: P0
- owner: ai
- depends_on: [TASK-066, TASK-061]
- goal: 根据 plan 生成 dry-run 预览，展示将影响的文件、卡片、关系。
- scope: 预览先于执行。
- deliverables:
  - preview generator
  - impact summary
- files:
  - src-tauri/src/services/agent/preview.rs
- acceptance:
  - 用户在确认前能看到影响范围
- prompt_hint: 实现 Agent 的 dry-run 预览器，输出 impact summary。

### TASK-068 Agent Executor
- status: todo
- priority: P0
- owner: ai
- depends_on: [TASK-067, TASK-063]
- goal: 用户确认后按 plan 执行白名单工具，并写入 task_logs。
- scope: 最小可用执行器。
- deliverables:
  - confirmAgentTask command
  - tool execution runtime
  - task logs
- files:
  - src-tauri/src/services/agent/executor.rs
- acceptance:
  - 已确认 plan 可执行并产生日志
- prompt_hint: 实现一个只执行已批准 plan 的 Agent Executor。

### TASK-069 Agent Console UI
- status: todo
- priority: P0
- owner: ai
- depends_on: [TASK-066, TASK-067, TASK-068]
- goal: 提供自然语言输入、plan 展示、preview、确认执行、回滚入口。
- scope: 先做控制台，不追求对话式复杂体验。
- deliverables:
  - agent console page
  - plan / preview / execute / rollback flow
- files:
  - apps/desktop/src/pages/agent/*
- acceptance:
  - 用户可完整走完 Agent 的计划到执行流程
- prompt_hint: 实现一个面向 plan/preview/execute/rollback 的 Agent 控制台。

### TASK-070 审计日志与 diff 查看器
- status: todo
- priority: P1
- owner: ai
- depends_on: [TASK-068]
- goal: 能查看每次 Agent 任务改动的对象、前后差异和结果。
- scope: 审计可视化。
- deliverables:
  - audit log viewer
  - diff viewer
- files:
  - apps/desktop/src/pages/agent/*
  - src-tauri/src/services/audit/*
- acceptance:
  - 用户可查看某次 task 的详细改动
- prompt_hint: 为 Agent 增加审计日志和 diff 可视化。

---

## Phase 7：导出、设置、测试与发布

### TASK-080 导出服务 v1
- status: todo
- priority: P0
- owner: ai
- depends_on: [TASK-045, TASK-051, TASK-068]
- goal: 支持把项目导出成 Markdown 知识库结构。
- scope: 文档、卡片、关系最小导出。
- deliverables:
  - exportProject command
  - export manifest
- files:
  - src-tauri/src/services/export/*
- acceptance:
  - 导出的目录可被人类直接浏览
- prompt_hint: 实现项目导出服务，输出清晰的 Markdown 知识库目录。

### TASK-081 设置页与模型配置
- status: todo
- priority: P0
- owner: ai
- depends_on: [TASK-040]
- goal: 支持配置模型 endpoint、API key、默认模式，并将敏感凭证存入系统凭证库。
- scope: 设置与安全。
- deliverables:
  - settings page
  - credential storage adapter
- files:
  - apps/desktop/src/pages/settings/*
  - src-tauri/src/services/settings/*
- acceptance:
  - 用户可配置模型，不明文存储密钥
- prompt_hint: 实现模型设置页和系统凭证存储集成。

### TASK-082 构建回归样本文档库
- status: todo
- priority: P0
- owner: ai
- depends_on: [TASK-025, TASK-026, TASK-027]
- goal: 收集固定 PDF、PPTX、DOCX、MD、TXT、异常文档样本，作为回归基线。
- scope: 测试素材与说明文档。
- deliverables:
  - fixtures/documents/*
  - fixtures README
- files:
  - fixtures/documents/*
- acceptance:
  - 有一组可重复使用的导入测试样本
- prompt_hint: 建立 KnowledgeOS 的回归样本文档库与使用说明。

### TASK-083 核心单元测试
- status: todo
- priority: P0
- owner: ai
- depends_on: [TASK-033, TASK-041, TASK-062]
- goal: 覆盖 block id 稳定性、explain schema、路径沙盒等核心单测。
- scope: 核心规则层。
- deliverables:
  - Rust unit tests
  - TS schema tests
  - Python parser tests
- files:
  - tests/*
- acceptance:
  - 核心规则层测试能稳定通过
- prompt_hint: 为最关键的规则层补足单元测试。

### TASK-084 集成测试：导入 -> 标准化 -> 切块
- status: todo
- priority: P0
- owner: ai
- depends_on: [TASK-028, TASK-034]
- goal: 打通从导入到 blocks 生成的集成链路。
- scope: 文档处理主链路。
- deliverables:
  - integration test suite
- files:
  - integration tests
- acceptance:
  - 使用固定样本可完成全链路测试
- prompt_hint: 写集成测试，验证导入到切块的完整流程。

### TASK-085 集成测试：Explain -> Card -> Graph
- status: todo
- priority: P0
- owner: ai
- depends_on: [TASK-042, TASK-045, TASK-051]
- goal: 验证解释、保存卡片、进入图谱主链路。
- scope: 知识沉淀主链路。
- deliverables:
  - integration tests
- files:
  - integration tests
- acceptance:
  - 可自动验证 Block -> Explain -> Card -> Graph 的闭环
- prompt_hint: 为知识沉淀闭环补齐集成测试。

### TASK-086 集成测试：Agent 预览 -> 执行 -> 回滚
- status: todo
- priority: P0
- owner: ai
- depends_on: [TASK-068, TASK-064]
- goal: 验证 Agent 安全执行主链路。
- scope: 风险最高的链路必须自动化验证。
- deliverables:
  - integration tests
- files:
  - integration tests
- acceptance:
  - 可自动测试回滚前后文件和 DB 是否恢复
- prompt_hint: 为 Agent 安全链路写强集成测试，覆盖 preview/execute/rollback。

### TASK-087 MVP 打包与安装验证
- status: todo
- priority: P1
- owner: ai
- depends_on: [TASK-080, TASK-081, TASK-083, TASK-084, TASK-085, TASK-086]
- goal: 完成本地打包、安装验证、sidecar 打包检查。
- scope: macOS / Windows 先做最小可安装版本。
- deliverables:
  - build scripts
  - packaging notes
- files:
  - scripts/*
  - docs/release/*
- acceptance:
  - 可生成可安装包并确认 parser sidecar 正常工作
- prompt_hint: 完成 Tauri 桌面应用的 MVP 打包与安装验证，确保 Python sidecar 可用。

### TASK-088 MVP 性能与交互收尾
- status: todo
- priority: P1
- owner: ai
- depends_on: [TASK-054, TASK-069, TASK-087]
- goal: 针对阅读器切换、图谱初次加载、搜索返回做一轮明显体验优化。
- scope: 只做最影响首版体验的优化。
- deliverables:
  - block list 虚拟化
  - 图谱按子图加载
  - explain cache 命中优化
- files:
  - reader / graph / search 相关模块
- acceptance:
  - 首版在中等项目下体验平稳可用
- prompt_hint: 只优化最明显的 3 个体验瓶颈，不做大规模重构。

---

# 8. 并行开发建议

## 8.1 可以并行的工作流

### Stream A：桌面壳与数据底座
- TASK-000 ~ TASK-015

### Stream B：文档解析
- TASK-022 ~ TASK-028

### Stream C：阅读器与切块
- TASK-030 ~ TASK-037

### Stream D：模型与解释
- TASK-040 ~ TASK-044

### Stream E：卡片、搜索、图谱
- TASK-045 ~ TASK-055

### Stream F：Agent 与安全
- TASK-060 ~ TASK-070

### Stream G：测试与打包
- TASK-080 ~ TASK-088

## 8.2 并行规则

- 没有 schema，不开始 UI 接入
- 没有落库结构，不开始搜索和图谱
- 没有快照与沙盒，不开始 Agent 执行
- 没有回归样本库，不宣布解析器完成

---

# 9. 建议的首批 14 个任务（最值得先喂给 AI）

如果你们现在就开始，建议按下面顺序先做：

1. TASK-000 初始化 monorepo
2. TASK-001 初始化 Tauri 应用
3. TASK-003 shared-types 包
4. TASK-010 SQLite 初始化
5. TASK-011 核心表结构 v1
6. TASK-012 Project Service
7. TASK-013 本地目录布局生成器
8. TASK-015 Typed Commands 骨架
9. TASK-020 导入流程与状态机
10. TASK-022 Python sidecar 协议
11. TASK-023 parser worker 骨架
12. TASK-024 Markdown/TXT 标准化
13. TASK-030 Block 数据结构
14. TASK-035 阅读器主布局 UI

这 14 个任务完成后，你们就已经拥有：

- 一个真正可运行的 Tauri 桌面骨架
- 项目系统
- 本地数据库
- 文档导入主链路骨架
- Python 解析 worker 接口
- Block-first 阅读器雏形

---

# 10. AI 执行提示词模板

下面这个模板建议作为你们每次喂给编码 AI 的统一格式：

```md
你现在要完成 KnowledgeOS 的一个独立开发任务。

任务 ID：TASK-XXX
任务标题：
目标：
依赖任务：
允许修改的目录：
禁止修改的目录：
必须遵守：
1. 不要修改未授权模块
2. 先实现最小可用版本
3. 输出需要包含：变更文件清单、实现说明、风险点、后续建议
4. 补充必要测试
5. 不要引入未说明的新框架

完成标准：
- [ ] 条件1
- [ ] 条件2
- [ ] 条件3

最后请输出：
1. 实现摘要
2. 修改文件列表
3. 运行方式
4. 已知限制
5. 下一步最合理任务
```

---

# 11. 给你的最终建议

## 11.1 技术路线建议

**直接上 Tauri，不建议先正式做 Electron 再重写。**

但请注意，不是“全功能都用 Rust 硬写”，而是：

- Tauri + Rust 做桌面壳和核心边界
- Python 做文档解析 worker
- React/TS 做 UI
- 所有模块通过显式 schema 连接

这条路线对 **纯 AI 开发** 最友好，因为：

- 结构边界清晰
- 单任务更容易局部完成
- 未来优化时不需要推倒重来
- 安全、性能和打包模型从第一天就走对了

## 11.2 管理方式建议

不要按“页面”给 AI 派活，尽量按“能力链路”给 AI 派活：

- 错误：做个首页、做个图谱页、做个设置页
- 正确：实现 project service、实现 import state machine、实现 block id、实现 explain cache

## 11.3 MVP 的真正重点

首版不是做“很多功能”，而是要打通这 4 条：

1. 导入并标准化
2. 切块并阅读
3. 解读并沉淀为卡片
4. Agent 预览执行并可回滚

只要这四条链路打通，这个 MVP 就成立了。

---

# 12. MVP 完成定义（Definition of Done）

满足以下条件即可视为首版完成：

- 用户可创建项目并导入 PDF/PPTX/DOCX/MD/TXT
- 导入后生成 Markdown 中间层与 manifest
- 文档可切分为稳定 Block
- 阅读器可逐块浏览并查看结构化 Explain
- 用户可将 Block / Explain 保存为 Card
- 图谱可展示 Card/Concept/Topic 的基础关系
- Agent 能生成 plan、preview、执行并回滚
- 项目可导出为本地 Markdown 知识库结构
- 至少有 3 条核心集成测试链路跑通

---

如果要继续拆下一层，优先继续写这 3 份文档：

1. `database_schema.md`
2. `ipc_commands.md`
3. `parser_protocol.md`
