import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { BootstrapState } from "../state";
import { createProject, enqueueMockJob, importFiles } from "../lib/commands/client";

interface DashboardProps {
  bootstrap: BootstrapState;
}

export function Dashboard({ bootstrap }: DashboardProps) {
  const queryClient = useQueryClient();
  const [importPathsText, setImportPathsText] = useState("E:\\NOTE\\fixtures\\documents\\sample-note.md");
  const [importFeedback, setImportFeedback] = useState<string | null>(null);
  const firstProject = bootstrap.projects[0] ?? null;
  const visibleDocuments = firstProject
    ? bootstrap.documents.filter((document) => document.projectId === firstProject.projectId)
    : bootstrap.documents;

  const createProjectMutation = useMutation({
    mutationFn: async () =>
      createProject({
        name: `项目 ${bootstrap.projects.length + 1}`,
        description: "由桌面壳初始化页创建"
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
    }
  });

  const enqueueJobMutation = useMutation({
    mutationFn: async () =>
      enqueueMockJob({
        kind: "mock.bootstrap",
        payload: { source: "dashboard" },
        maxAttempts: 3
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
    }
  });

  const importFilesMutation = useMutation({
    mutationFn: async () => {
      if (!firstProject) {
        throw new Error("请先创建项目再导入文档。");
      }

      const paths = importPathsText
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);

      return importFiles({
        projectId: firstProject.projectId,
        paths
      });
    },
    onSuccess: async (result) => {
      const importedCount = result.documents.length;
      const errorCount = result.errors.length;
      setImportFeedback(`已导入 ${importedCount} 个文档，失败 ${errorCount} 个，已排入 ${result.queuedJobIds.length} 个解析任务。`);
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
    },
    onError: (error: Error) => {
      setImportFeedback(error.message);
    }
  });

  return (
    <main className="app-shell">
      <section className="hero-card">
        <div>
          <p className="eyebrow">KnowledgeOS</p>
          <h1>桌面壳与数据底座</h1>
          <p className="hero-copy">
            当前阶段已切换到 Tauri + React + TypeScript + Rust + SQLite 架构，不使用 Electron。
          </p>
        </div>
        <div className="button-row">
          <button onClick={() => createProjectMutation.mutate()} disabled={createProjectMutation.isPending}>
            创建示例项目
          </button>
          <button
            className="secondary"
            onClick={() => enqueueJobMutation.mutate()}
            disabled={enqueueJobMutation.isPending}
          >
            创建 Mock Job
          </button>
        </div>
      </section>

      <section className="info-grid">
        <article className="panel">
          <h2>应用信息</h2>
          <dl className="key-values">
            <div>
              <dt>应用名</dt>
              <dd>{bootstrap.appName}</dd>
            </div>
            <div>
              <dt>数据目录</dt>
              <dd>{bootstrap.dataDir}</dd>
            </div>
            <div>
              <dt>日志目录</dt>
              <dd>{bootstrap.logDir}</dd>
            </div>
          </dl>
        </article>

        <article className="panel">
          <h2>项目列表</h2>
          <ul className="item-list">
            {bootstrap.projects.length === 0 ? <li>暂无项目</li> : null}
            {bootstrap.projects.map((project) => (
              <li key={project.projectId}>
                <strong>{project.name}</strong>
                <span>{project.rootPath}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h2>导入流程</h2>
          <p className="panel-copy">
            `TASK-020` 当前提供导入状态机骨架。导入成功的文档会写入 `source` 目录，并进入 `parsing` 状态，同时排入 mock 解析任务。
          </p>
          <textarea
            className="path-input"
            value={importPathsText}
            onChange={(event) => setImportPathsText(event.target.value)}
            rows={4}
          />
          <div className="button-row">
            <button onClick={() => importFilesMutation.mutate()} disabled={importFilesMutation.isPending || !firstProject}>
              导入文档
            </button>
          </div>
          <p className="feedback-text">{importFeedback ?? (firstProject ? "可输入一个或多个绝对路径，每行一个。" : "请先创建项目。")}</p>
        </article>

        <article className="panel">
          <h2>任务队列</h2>
          <ul className="item-list">
            {bootstrap.jobs.length === 0 ? <li>暂无任务</li> : null}
            {bootstrap.jobs.map((job) => (
              <li key={job.jobId}>
                <strong>{job.kind}</strong>
                <span>
                  {job.status} / {job.attempts} / {job.maxAttempts}
                </span>
              </li>
            ))}
          </ul>
        </article>

        <article className="panel panel-wide">
          <h2>文档状态</h2>
          <ul className="item-list">
            {visibleDocuments.length === 0 ? <li>当前项目暂无文档</li> : null}
            {visibleDocuments.map((document) => (
              <li key={document.documentId}>
                <strong>{document.title ?? document.sourcePath}</strong>
                <span>
                  {document.sourceType} / {document.parseStatus}
                </span>
                <span>{document.sourcePath}</span>
                {document.lastErrorMessage ? <span>错误：{document.lastErrorMessage}</span> : null}
              </li>
            ))}
          </ul>
        </article>
      </section>
    </main>
  );
}
