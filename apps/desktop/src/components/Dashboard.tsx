import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { BootstrapState } from "../state";
import {
  cancelJob,
  createProject,
  deleteProject,
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
    : [];
  const visibleBlocks = currentProject
    ? bootstrap.blocks.filter((block) => block.projectId === currentProject.projectId)
    : [];
  const visibleJobs = useMemo(() => {
    if (!currentProject) {
      return bootstrap.jobs;
    }
    return bootstrap.jobs.filter((job) => job.payloadJson.includes(currentProject.projectId));
  }, [bootstrap.jobs, currentProject]);

  const readyDocumentCount = visibleDocuments.filter((document) =>
    ["chunked", "indexed", "ready"].includes(document.parseStatus)
  ).length;

  const createProjectMutation = useMutation({
    mutationFn: async () =>
      createProject({
        name: `项目 ${bootstrap.projects.length + 1}`,
        description: "KnowledgeOS 工作台项目"
      }),
    onSuccess: async (result) => {
      setSelectedProjectId(result.project.projectId);
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
      setImportFeedback(
        `已导入 ${result.documents.length} 个文档，失败 ${result.errors.length} 个，已排入 ${result.queuedJobIds.length} 个任务。`
      );
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
      <section className="workspace-frame">
        <aside className="workspace-rail">
          <div className="brand-badge">K</div>
          <button className="rail-button rail-button-active">工作台</button>
          <button className="rail-button">项目</button>
          <button className="rail-button">阅读器</button>
          <button className="rail-button">图谱</button>
          <button className="rail-button">卡片</button>
          <button className="rail-button">Agent</button>
        </aside>

        <aside className="workspace-sidebar">
          <header className="sidebar-header">
            <div>
              <p className="section-kicker">KnowledgeOS</p>
              <h1>学习知识工作台</h1>
            </div>
            <button onClick={() => createProjectMutation.mutate()} disabled={createProjectMutation.isPending}>
              新建项目
            </button>
          </header>

          <section className="sidebar-panel">
            <div className="panel-heading">
              <div>
                <p className="section-kicker">Projects</p>
                <h2>项目空间</h2>
              </div>
              <span>{bootstrap.projects.length} 个项目</span>
            </div>
            <div className="project-stack">
              {bootstrap.projects.length === 0 ? <p className="muted-copy">还没有项目，先创建一个工作空间。</p> : null}
              {bootstrap.projects.map((project) => (
                <article
                  key={project.projectId}
                  className={project.projectId === currentProject?.projectId ? "project-card project-card-active" : "project-card"}
                >
                  <button
                    className="project-card-main"
                    onClick={() => openProjectMutation.mutate({ projectId: project.projectId })}
                  >
                    <strong>{project.name}</strong>
                    <span>{project.description ?? "本地优先知识项目"}</span>
                    <small>{project.rootPath}</small>
                  </button>
                  <div className="project-card-actions">
                    <button
                      className="secondary"
                      onClick={() =>
                        deleteProjectMutation.mutate({
                          projectId: project.projectId,
                          deleteFiles: true
                        })
                      }
                    >
                      删除
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="sidebar-panel">
            <div className="panel-heading">
              <div>
                <p className="section-kicker">Import</p>
                <h2>资料导入</h2>
              </div>
            </div>
            <textarea
              className="path-input"
              value={importPathsText}
              onChange={(event) => setImportPathsText(event.target.value)}
              rows={4}
            />
            <div className="button-row">
              <button onClick={() => importFilesMutation.mutate()} disabled={importFilesMutation.isPending || !currentProject}>
                导入到当前项目
              </button>
            </div>
            <p className="muted-copy">
              {importFeedback ?? "每行一个绝对路径。导入后会自动进入解析与切块任务队列。"}
            </p>
          </section>

          <section className="sidebar-panel">
            <div className="panel-heading">
              <div>
                <p className="section-kicker">Queue</p>
                <h2>任务队列</h2>
              </div>
            </div>
            <div className="job-stack">
              {visibleJobs.length === 0 ? <p className="muted-copy">当前项目暂无任务。</p> : null}
              {visibleJobs.map((job) => (
                <article key={job.jobId} className="job-card">
                  <div>
                    <strong>{job.kind}</strong>
                    <p>{job.status} / {job.attempts} / {job.maxAttempts}</p>
                  </div>
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
                </article>
              ))}
            </div>
          </section>
        </aside>

        <section className="workspace-main">
          <header className="workspace-topbar">
            <div>
              <p className="section-kicker">Workspace</p>
              <h2>{currentProject?.name ?? "请选择项目"}</h2>
              <p className="muted-copy">
                {currentProject
                  ? `${currentProject.rootPath}`
                  : "创建项目后即可开始导入资料、逐块阅读并沉淀知识卡片。"}
              </p>
            </div>
            <div className="stats-row">
              <article className="stat-card">
                <span>文档</span>
                <strong>{visibleDocuments.length}</strong>
              </article>
              <article className="stat-card">
                <span>可阅读</span>
                <strong>{readyDocumentCount}</strong>
              </article>
              <article className="stat-card">
                <span>Blocks</span>
                <strong>{visibleBlocks.length}</strong>
              </article>
            </div>
          </header>

          <section className="workspace-overview">
            <article className="overview-panel">
              <div className="panel-heading">
                <div>
                  <p className="section-kicker">Documents</p>
                  <h3>资料走廊</h3>
                </div>
              </div>
              <div className="document-grid">
                {visibleDocuments.length === 0 ? <p className="muted-copy">导入资料后，这里会显示你的课程文档与阅读进度。</p> : null}
                {visibleDocuments.map((document) => (
                  <article key={document.documentId} className="document-card">
                    <strong>{document.title ?? document.sourcePath}</strong>
                    <span>{document.sourceType} / {document.parseStatus}</span>
                    <small>{document.sourcePath}</small>
                    {document.lastErrorMessage ? <em>错误：{document.lastErrorMessage}</em> : null}
                  </article>
                ))}
              </div>
            </article>
          </section>

          <ReaderWorkspace
            projectId={currentProject?.projectId ?? ""}
            documents={bootstrap.documents}
            bootstrapBlocks={bootstrap.blocks}
            readerStates={bootstrap.readerStates}
          />
        </section>
      </section>
    </main>
  );
}
