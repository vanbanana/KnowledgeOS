import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { BootstrapState } from "../state";
import {
  cancelJob,
  createProject,
  deleteProject,
  enqueueMockJob,
  importFiles,
  openProject,
  retryJob,
  runJob
} from "../lib/commands/client";
import { ReaderWorkspace } from "./ReaderWorkspace";

interface DashboardProps {
  bootstrap: BootstrapState;
}

export function Dashboard({ bootstrap }: DashboardProps) {
  const queryClient = useQueryClient();
  const [importPathsText, setImportPathsText] = useState("E:\\NOTE\\fixtures\\documents\\sample-note.md");
  const [importFeedback, setImportFeedback] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(bootstrap.projects[0]?.projectId ?? null);
  const currentProject =
    bootstrap.projects.find((project) => project.projectId === selectedProjectId) ?? bootstrap.projects[0] ?? null;
  const visibleDocuments = currentProject
    ? bootstrap.documents.filter((document) => document.projectId === currentProject.projectId)
    : bootstrap.documents;

  const createProjectMutation = useMutation({
    mutationFn: async () =>
      createProject({
        name: `项目 ${bootstrap.projects.length + 1}`,
        description: "由桌面壳初始化页创建"
      }),
    onSuccess: async (result) => {
      setSelectedProjectId(result.project.projectId);
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
      if (!currentProject) {
        throw new Error("请先创建项目再导入文档。");
      }

      const paths = importPathsText
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);

      return importFiles({
        projectId: currentProject.projectId,
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

  const openProjectMutation = useMutation({
    mutationFn: openProject,
    onSuccess: async (result) => {
      setSelectedProjectId(result.project.projectId);
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
    }
  });

  const deleteProjectMutation = useMutation({
    mutationFn: deleteProject,
    onSuccess: async (_, variables) => {
      if (selectedProjectId === variables.projectId) {
        setSelectedProjectId(null);
      }
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
    }
  });

  const runJobMutation = useMutation({
    mutationFn: runJob,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
    }
  });

  const retryJobMutation = useMutation({
    mutationFn: retryJob,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
    }
  });

  const cancelJobMutation = useMutation({
    mutationFn: cancelJob,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
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
          <p className="feedback-text">
            当前项目：{currentProject ? `${currentProject.name} / ${currentProject.rootPath}` : "未选择"}
          </p>
          <ul className="item-list">
            {bootstrap.projects.length === 0 ? <li>暂无项目</li> : null}
            {bootstrap.projects.map((project) => (
              <li
                key={project.projectId}
                className={project.projectId === currentProject?.projectId ? "item-active" : undefined}
              >
                <strong>{project.name}</strong>
                <span>{project.rootPath}</span>
                <div className="button-row">
                  <button
                    className="secondary"
                    onClick={() => openProjectMutation.mutate({ projectId: project.projectId })}
                  >
                    {project.projectId === currentProject?.projectId ? "当前项目" : "打开项目"}
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      deleteProjectMutation.mutate({
                        projectId: project.projectId,
                        deleteFiles: true
                      })
                    }
                  >
                    删除项目
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h2>导入流程</h2>
          <p className="panel-copy">
            当前已打通导入、标准化、切块与阅读器基础链路。导入成功的文档会写入 `source` 目录，进入
            `parsing` 状态，并排入 `document.parse` 与后续 `document.chunk` 任务。
          </p>
          <textarea
            className="path-input"
            value={importPathsText}
            onChange={(event) => setImportPathsText(event.target.value)}
            rows={4}
          />
          <div className="button-row">
            <button onClick={() => importFilesMutation.mutate()} disabled={importFilesMutation.isPending || !currentProject}>
              导入文档
            </button>
          </div>
          <p className="feedback-text">{importFeedback ?? (currentProject ? "可输入一个或多个绝对路径，每行一个。" : "请先创建项目。")}</p>
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
                <div className="button-row">
                  <button
                    className="secondary"
                    disabled={job.status !== "pending" || runJobMutation.isPending}
                    onClick={() => runJobMutation.mutate({ jobId: job.jobId })}
                  >
                    运行
                  </button>
                  <button
                    className="secondary"
                    disabled={job.status !== "failed" || retryJobMutation.isPending}
                    onClick={() => retryJobMutation.mutate({ jobId: job.jobId })}
                  >
                    重试
                  </button>
                  <button
                    className="secondary"
                    disabled={job.status === "succeeded" || job.status === "cancelled" || cancelJobMutation.isPending}
                    onClick={() => cancelJobMutation.mutate({ jobId: job.jobId })}
                  >
                    取消
                  </button>
                </div>
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

        <article className="panel panel-wide">
          <h2>Block 阅读器</h2>
          {currentProject ? (
            <ReaderWorkspace
              projectId={currentProject.projectId}
              documents={bootstrap.documents}
              bootstrapBlocks={bootstrap.blocks}
              readerStates={bootstrap.readerStates}
            />
          ) : (
            <p className="feedback-text">请先创建并打开一个项目。</p>
          )}
        </article>
      </section>
    </main>
  );
}
