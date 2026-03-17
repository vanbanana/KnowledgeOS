import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Document } from "@knowledgeos/shared-types";
import type { BootstrapState } from "../state";
import {
  cancelJob,
  createProject,
  deleteProject,
  hybridSearchProject,
  importFiles,
  openProject,
  retryJob,
  runJob
} from "../lib/commands/client";
import { CardsWorkspace } from "./CardsWorkspace";
import { GraphWorkspace } from "./GraphWorkspace";
import { ReaderWorkspace } from "./ReaderWorkspace";

interface DashboardProps {
  bootstrap: BootstrapState;
}

export function Dashboard({ bootstrap }: DashboardProps) {
  const queryClient = useQueryClient();
  const [importPathsText, setImportPathsText] = useState("E:\\NOTE\\fixtures\\documents\\sample-note.md");
  const [importFeedback, setImportFeedback] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(bootstrap.projects[0]?.projectId ?? null);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<"项目" | "阅读器" | "卡片" | "图谱" | "Agent">("阅读器");
  const [searchText, setSearchText] = useState("");

  const currentProject =
    bootstrap.projects.find((project) => project.projectId === selectedProjectId) ?? bootstrap.projects[0] ?? null;
  const projectDocuments = currentProject
    ? bootstrap.documents.filter((document) => document.projectId === currentProject.projectId)
    : [];
  const currentDocument =
    projectDocuments.find((document) => document.documentId === selectedDocumentId) ?? projectDocuments[0] ?? null;

  const currentProjectJobs = useMemo(() => {
    if (!currentProject) {
      return bootstrap.jobs;
    }
    return bootstrap.jobs.filter((job) => job.payloadJson.includes(currentProject.projectId));
  }, [bootstrap.jobs, currentProject]);

  const searchQuery = useQuery({
    queryKey: ["hybrid-search", currentProject?.projectId, searchText],
    queryFn: async () => hybridSearchProject({ projectId: currentProject!.projectId, query: searchText }),
    enabled: Boolean(currentProject?.projectId && searchText.trim().length > 0)
  });

  const createProjectMutation = useMutation({
    mutationFn: async () =>
      createProject({
        name: `项目 ${bootstrap.projects.length + 1}`,
        description: "KnowledgeOS 工作站项目"
      }),
    onSuccess: async (result) => {
      setSelectedProjectId(result.project.projectId);
      setSelectedDocumentId(null);
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
    }
  });

  const openProjectMutation = useMutation({
    mutationFn: openProject,
    onSuccess: async (result) => {
      setSelectedProjectId(result.project.projectId);
      setSelectedDocumentId(null);
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
    }
  });

  const deleteProjectMutation = useMutation({
    mutationFn: deleteProject,
    onSuccess: async (_, variables) => {
      if (selectedProjectId === variables.projectId) {
        setSelectedProjectId(null);
        setSelectedDocumentId(null);
      }
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
    }
  });

  const importFilesMutation = useMutation({
    mutationFn: async () => {
      if (!currentProject) {
        throw new Error("请先创建项目再导入资料。");
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
        `已导入 ${result.documents.length} 个文件，失败 ${result.errors.length} 个，新增 ${result.queuedJobIds.length} 个后台任务。`
      );
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
    },
    onError: (error: Error) => {
      setImportFeedback(error.message);
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
    <main className="desktop-shell">
      <header className="desktop-menubar">
        <div className="menubar-left">
          <button className="window-ghost">×</button>
          <div className="app-brand">
            <span className="brand-square" />
            <span>KnowledgeOS</span>
          </div>
        </div>
        <nav className="menubar-nav">
          <button>文件</button>
          <button>编辑</button>
          <button>查看</button>
          <button>工具</button>
          <button>帮助</button>
        </nav>
      </header>

      <section className="desktop-layout">
        <aside className="sidebar-icons">
          <button className="icon-slot icon-slot-active">搜</button>
          <button className="icon-slot">库</button>
          <button className="icon-slot">读</button>
          <div className="sidebar-icons-spacer" />
          <button className="icon-slot">签</button>
          <button className="icon-slot">设</button>
        </aside>

        <aside className="library-pane">
          <div className="library-search-row">
            <input
              className="search-button plain-input"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="搜索项目 / 块 / 卡片"
            />
            <button className="square-tool-button">搜</button>
          </div>

          <div className="library-toolbar-row">
            <button
              className="primary-outline-button"
              onClick={() => createProjectMutation.mutate()}
              disabled={createProjectMutation.isPending}
            >
              + 新建项目
            </button>
          </div>

          <section className="library-block">
            <div className="library-caption">工作区</div>
            <div className="mode-stack">
              {(["项目", "阅读器", "卡片", "图谱", "Agent"] as const).map((item) => (
                <button
                  key={item}
                  className={currentView === item ? "mode-row mode-row-active" : "mode-row"}
                  onClick={() => setCurrentView(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </section>

          {searchText.trim() ? (
            <section className="library-block library-tree-block">
              <div className="library-block-header">
                <span className="library-caption">搜索结果</span>
                <span className="library-count">{searchQuery.data?.results.length ?? 0}</span>
              </div>
              <div className="tree-scroll">
                {(searchQuery.data?.results ?? []).map((result) => (
                  <button
                    key={`${result.entityType}-${result.entityId}`}
                    className="tree-document-row"
                    onClick={() => {
                      setCurrentView(result.entityType === "card" ? "卡片" : result.entityType === "block" ? "阅读器" : currentView);
                      if (result.entityType === "block") {
                        const match = bootstrap.blocks.find((item) => item.blockId === result.entityId);
                        if (match) {
                          setSelectedDocumentId(match.documentId);
                        }
                      }
                    }}
                  >
                    <span className="tree-document-name">{result.title}</span>
                    <span className="tree-document-state">{result.source}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <section className="library-block library-tree-block">
            <div className="library-block-header">
              <span className="library-caption">资源库</span>
              <span className="library-count">{bootstrap.projects.length}</span>
            </div>

            <div className="tree-root-label">Projects</div>
            <div className="tree-scroll">
              {bootstrap.projects.map((project) => (
                <div key={project.projectId} className="tree-project">
                  <button
                    className={project.projectId === currentProject?.projectId ? "tree-project-row tree-project-row-active" : "tree-project-row"}
                    onClick={() => openProjectMutation.mutate({ projectId: project.projectId })}
                  >
                    <span className="tree-arrow">▾</span>
                    <span className="tree-project-name">{project.name}</span>
                  </button>

                  {project.projectId === currentProject?.projectId ? (
                    <div className="tree-document-list">
                      {projectDocuments.length === 0 ? <div className="empty-hint">暂无文档</div> : null}
                      {projectDocuments.map((document) => (
                        <button
                          key={document.documentId}
                          className={document.documentId === currentDocument?.documentId ? "tree-document-row tree-document-row-active" : "tree-document-row"}
                          onClick={() => setSelectedDocumentId(document.documentId)}
                        >
                          <span className="tree-document-name">{getDocumentDisplayName(document)}</span>
                          <span className="tree-document-state">{document.parseStatus}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </section>

          <section className="library-block">
            <div className="library-caption">导入资料</div>
            <textarea
              className="import-editor"
              value={importPathsText}
              onChange={(event) => setImportPathsText(event.target.value)}
              rows={4}
            />
            <button
              className="gold-button"
              onClick={() => importFilesMutation.mutate()}
              disabled={importFilesMutation.isPending || !currentProject}
            >
              导入到当前项目
            </button>
            <p className="note-text">
              {importFeedback ?? "每行一个绝对路径。导入后会进入解析与切块任务队列。"}
            </p>
          </section>

          <section className="library-block queue-block">
            <div className="library-block-header">
              <span className="library-caption">任务队列</span>
              <span className="library-count">{currentProjectJobs.length}</span>
            </div>

            <div className="job-scroll">
              {currentProjectJobs.length === 0 ? <div className="empty-hint">当前项目暂无任务</div> : null}
              {currentProjectJobs.map((job) => (
                <div key={job.jobId} className="job-item">
                  <div className="job-item-head">
                    <strong>{job.kind}</strong>
                    <span>{job.status}</span>
                  </div>
                  <div className="job-item-actions">
                    <button
                      className="small-button"
                      disabled={job.status !== "pending" || runJobMutation.isPending}
                      onClick={() => runJobMutation.mutate({ jobId: job.jobId })}
                    >
                      运行
                    </button>
                    <button
                      className="small-button"
                      disabled={job.status !== "failed" || retryJobMutation.isPending}
                      onClick={() => retryJobMutation.mutate({ jobId: job.jobId })}
                    >
                      重试
                    </button>
                    <button
                      className="small-button"
                      disabled={job.status === "succeeded" || job.status === "cancelled" || cancelJobMutation.isPending}
                      onClick={() => cancelJobMutation.mutate({ jobId: job.jobId })}
                    >
                      取消
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {currentProject ? (
            <section className="library-footer">
              <div className="note-text">{currentProject.rootPath}</div>
              <button
                className="small-button"
                onClick={() =>
                  deleteProjectMutation.mutate({
                    projectId: currentProject.projectId,
                    deleteFiles: true
                  })
                }
              >
                删除当前项目
              </button>
            </section>
          ) : null}
        </aside>

        {currentView === "卡片" ? (
          <CardsWorkspace currentProject={currentProject} />
        ) : currentView === "图谱" ? (
          <GraphWorkspace
            currentProject={currentProject}
            onJumpToBlock={(blockId) => {
              const match = bootstrap.blocks.find((item) => item.blockId === blockId);
              if (!match) {
                return;
              }
              setSelectedDocumentId(match.documentId);
              setCurrentView("阅读器");
            }}
          />
        ) : (
          <ReaderWorkspace
            currentProject={currentProject}
            documents={projectDocuments}
            currentDocument={currentDocument}
            onSelectDocument={setSelectedDocumentId}
            bootstrapBlocks={bootstrap.blocks}
            readerStates={bootstrap.readerStates}
          />
        )}
      </section>
    </main>
  );
}

function getDocumentDisplayName(document: Document) {
  return document.title ?? document.sourcePath.split(/[/\\]/).pop() ?? document.sourcePath;
}
