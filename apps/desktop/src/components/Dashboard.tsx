import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Block, Document, Project, ReaderState } from "@knowledgeos/shared-types";
import {
  createProject,
  deleteDocument,
  deleteProject,
  hybridSearchProject,
  importFiles,
  listDocuments,
  listJobs,
  openProject,
  renameProject,
  runJob
} from "../lib/commands/client";
import { AgentWorkspace } from "./AgentWorkspace";
import { CardsWorkspace } from "./CardsWorkspace";
import { GraphWorkspace } from "./GraphWorkspace";
import { ReaderWorkspace } from "./ReaderWorkspace";

interface DashboardProps {
  bootstrap: {
    projects: Project[];
    documents: Document[];
    blocks: Block[];
    readerStates: ReaderState[];
  };
}

interface ProjectContextMenuState {
  targetType: "project" | "document";
  projectId: string;
  documentId?: string;
  x: number;
  y: number;
}

export function Dashboard({ bootstrap }: DashboardProps) {
  const queryClient = useQueryClient();
  const [importPaths, setImportPaths] = useState<string[]>([]);
  const [importFeedback, setImportFeedback] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(bootstrap.projects[0]?.projectId ?? null);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<"项目" | "阅读器" | "卡片" | "图谱" | "Agent">("阅读器");
  const [searchText, setSearchText] = useState("");
  const [isImportDragActive, setIsImportDragActive] = useState(false);
  const [projectContextMenu, setProjectContextMenu] = useState<ProjectContextMenuState | null>(null);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<string[]>([]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const currentProject =
    bootstrap.projects.find((project) => project.projectId === selectedProjectId) ?? bootstrap.projects[0] ?? null;
  const projectDocuments = currentProject
    ? bootstrap.documents.filter((document) => document.projectId === currentProject.projectId)
    : [];
  const currentDocument =
    projectDocuments.find((document) => document.documentId === selectedDocumentId) ?? projectDocuments[0] ?? null;

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
      setProjectContextMenu(null);
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
    }
  });

  const renameProjectMutation = useMutation({
    mutationFn: renameProject,
    onSuccess: async (result) => {
      setSelectedProjectId(result.project.projectId);
      setProjectContextMenu(null);
      setRenamingProjectId(null);
      setRenameDraft("");
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
      setProjectContextMenu(null);
      setRenamingProjectId(null);
      setRenameDraft("");
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
    }
  });

  const deleteDocumentMutation = useMutation({
    mutationFn: deleteDocument,
    onSuccess: async (_, variables) => {
      if (selectedDocumentId === variables.documentId) {
        setSelectedDocumentId(null);
      }
      setProjectContextMenu(null);
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
    }
  });

  const importFilesMutation = useMutation({
    mutationFn: async (paths: string[]) => {
      if (!currentProject) {
        throw new Error("请先创建项目再导入资料。");
      }
      const result = await importFiles({
        projectId: currentProject.projectId,
        paths
      });
      await processImportPipeline(currentProject.projectId, result.documents.map((item) => item.documentId));
      return result;
    },
    onSuccess: async (result) => {
      setImportFeedback(
        result.errors.length > 0 ? `有 ${result.errors.length} 个资料未能完成转换。` : null
      );
      setImportPaths([]);
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
    },
    onError: (error: Error) => {
      setImportFeedback(error.message);
    }
  });

  useEffect(() => {
    const closeMenu = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".project-context-menu")) {
        return;
      }
      setProjectContextMenu(null);
    };
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProjectContextMenu(null);
        setRenamingProjectId(null);
      }
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", handleKeyboard);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", handleKeyboard);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (cancelled) {
          return;
        }
        const payload = event.payload;
        if (payload.type === "enter") {
          setIsImportDragActive(true);
          return;
        }
        if (payload.type === "over") {
          setIsImportDragActive(true);
          return;
        }
        if (payload.type === "drop") {
            setIsImportDragActive(false);
            if (payload.paths.length > 0) {
              const nextPaths = mergeImportPaths([], payload.paths);
              setImportPaths(nextPaths);
              setImportFeedback(null);
              importFilesMutation.mutate(nextPaths);
            }
          return;
        }
        if (payload.type === "leave") {
          setIsImportDragActive(false);
        }
      })
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch(() => {
        setIsImportDragActive(false);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  async function processImportPipeline(projectId: string, importedDocumentIds: string[]) {
    await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
    for (let round = 0; round < 8; round += 1) {
      const jobResult = await listJobs();
      const pendingJobs = jobResult.jobs.filter(
        (job) =>
          job.status === "pending"
          && (job.kind === "document.parse" || job.kind === "document.chunk")
          && job.payloadJson.includes(projectId)
          && importedDocumentIds.some((documentId) => job.payloadJson.includes(documentId))
      );
      if (pendingJobs.length === 0) {
        break;
      }
      for (const job of pendingJobs) {
        await runJob({ jobId: job.jobId });
      }
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
    }

    const documentsResult = await listDocuments(projectId);
    const latestImportedDocument = documentsResult.documents.find((item) => importedDocumentIds.includes(item.documentId)) ?? null;
    if (latestImportedDocument) {
      setSelectedDocumentId(latestImportedDocument.documentId);
      setCurrentView("阅读器");
    }
  }

  async function submitProjectRename(project: Project) {
    if (!renameDraft.trim() || renameProjectMutation.isPending) {
      return;
    }
    await renameProjectMutation.mutateAsync({
      projectId: project.projectId,
      name: renameDraft.trim(),
      description: project.description
    });
  }

  async function beginWindowDrag() {
    try {
      await invoke("start_window_drag_command");
    } catch {
      // 忽略拖动失败，避免影响其他交互
    }
  }

  function toggleProjectCollapsed(projectId: string) {
    setCollapsedProjectIds((current) =>
      current.includes(projectId)
        ? current.filter((item) => item !== projectId)
        : [...current, projectId]
    );
  }

  return (
    <main className="desktop-shell desktop-shell-windowless">
      <header className="topbar-shell">
        <div
          className="topbar-brand"
          onMouseDown={(event) => {
            if (event.button !== 0) {
              return;
            }
            void beginWindowDrag();
          }}
        >
          <SvgBrandMark />
        </div>
        <nav className="topbar-menu">
          {["文件", "编辑", "查看", "工具", "帮助"].map((label) => (
            <button key={label} className="topbar-menu-button">
              {label}
            </button>
          ))}
        </nav>
        <div
          className="topbar-drag-region"
          onMouseDown={(event) => {
            if (event.button !== 0) {
              return;
            }
            void beginWindowDrag();
          }}
        />
        <div className="topbar-controls">
          <button
            className="window-control-button"
            aria-label="最小化"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={async (event) => {
              event.preventDefault();
              event.stopPropagation();
              await invoke("minimize_window_command");
            }}
          >
            <svg className="window-control-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 8.5H13" />
            </svg>
          </button>
          <button
            className="window-control-button"
            aria-label="最大化"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={async (event) => {
              event.preventDefault();
              event.stopPropagation();
              await invoke("toggle_maximize_window_command");
            }}
          >
            <svg className="window-control-icon" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="3.5" y="3.5" width="9" height="9" />
            </svg>
          </button>
          <button
            className="window-control-button window-control-button-close"
            aria-label="关闭"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={async (event) => {
              event.preventDefault();
              event.stopPropagation();
              await invoke("close_window_command");
            }}
          >
            <svg className="window-control-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4L12 12M12 4L4 12" />
            </svg>
          </button>
        </div>
      </header>

      <section className="desktop-layout desktop-layout-windowless">
        <aside className="sidebar-icons sidebar-icons-windowless">
          <button
            className="icon-slot"
            onClick={() => {
              setCurrentView("项目");
              searchInputRef.current?.focus();
            }}
            aria-label="搜索"
            title="搜索"
          >
            <SvgSearchIcon />
          </button>
          <button
            className="icon-slot"
            onClick={() => createProjectMutation.mutate()}
            disabled={createProjectMutation.isPending}
            aria-label="新建项目"
            title="新建项目"
          >
            <SvgPlusIcon />
          </button>
          <button className={currentView === "项目" ? "icon-slot icon-slot-active" : "icon-slot"} onClick={() => setCurrentView("项目")} aria-label="项目">
            <SvgFolderIcon />
          </button>
          <button className={currentView === "阅读器" ? "icon-slot icon-slot-active" : "icon-slot"} onClick={() => setCurrentView("阅读器")} aria-label="阅读器">
            <SvgDocumentIcon />
          </button>
          <button className={currentView === "卡片" ? "icon-slot icon-slot-active" : "icon-slot"} onClick={() => setCurrentView("卡片")} aria-label="卡片">
            <SvgCardsIcon />
          </button>
          <button className={currentView === "图谱" ? "icon-slot icon-slot-active" : "icon-slot"} onClick={() => setCurrentView("图谱")} aria-label="图谱">
            <SvgGraphIcon />
          </button>
          <div className="sidebar-icons-spacer" />
          <button className={currentView === "Agent" ? "icon-slot icon-slot-active" : "icon-slot"} onClick={() => setCurrentView("Agent")} aria-label="Agent">
            <SvgSparkIcon />
          </button>
        </aside>

        <aside className="library-pane">
          <div className="library-pane-top">
            <div className="library-search-row">
              <input
                ref={searchInputRef}
                className="search-button plain-input"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="搜索项目 / 块 / 卡片"
              />
            </div>
          </div>

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
                <div
                  key={project.projectId}
                  className="tree-project"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setProjectContextMenu({
                      targetType: "project",
                      projectId: project.projectId,
                      x: event.clientX,
                      y: event.clientY
                    });
                  }}
                >
                  {renamingProjectId === project.projectId ? (
                    <div className="tree-project-rename-row">
                      <span className="tree-arrow">▾</span>
                      <input
                        className="tree-rename-input"
                        value={renameDraft}
                        autoFocus
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={async (event) => {
                          if (event.key === "Escape") {
                            setRenamingProjectId(null);
                            setRenameDraft("");
                            return;
                          }
                          if (event.key !== "Enter") {
                            return;
                          }
                          await submitProjectRename(project);
                        }}
                        onBlur={() => {
                          if (!renameDraft.trim()) {
                            setRenamingProjectId(null);
                            setRenameDraft("");
                            return;
                          }
                          void submitProjectRename(project);
                        }}
                      />
                    </div>
                  ) : (
                    <button
                      className={project.projectId === currentProject?.projectId ? "tree-project-row tree-project-row-active" : "tree-project-row"}
                      onClick={() => {
                        if (project.projectId !== currentProject?.projectId) {
                          openProjectMutation.mutate({ projectId: project.projectId });
                          setCollapsedProjectIds((current) => current.filter((item) => item !== project.projectId));
                          return;
                        }
                        toggleProjectCollapsed(project.projectId);
                      }}
                    >
                      <span className="tree-arrow" aria-hidden="true">
                        {collapsedProjectIds.includes(project.projectId) ? <SvgChevronRightIcon /> : <SvgChevronDownIcon />}
                      </span>
                      <span className="tree-project-name">{project.name}</span>
                    </button>
                  )}

                  {project.projectId === currentProject?.projectId && !collapsedProjectIds.includes(project.projectId) ? (
                    <div className="tree-document-list">
                      {projectDocuments.length === 0 ? <div className="empty-hint">暂无文档</div> : null}
                      {projectDocuments.map((document) => (
                        <button
                          key={document.documentId}
                          className={document.documentId === currentDocument?.documentId ? "tree-document-row tree-document-row-active" : "tree-document-row"}
                          onClick={() => {
                            setSelectedDocumentId(document.documentId);
                            setCurrentView("阅读器");
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setProjectContextMenu({
                              targetType: "document",
                              projectId: project.projectId,
                              documentId: document.documentId,
                              x: event.clientX,
                              y: event.clientY
                            });
                          }}
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
            <button
              className={
                importFilesMutation.isPending
                  ? "import-dropzone import-dropzone-processing"
                  : isImportDragActive
                    ? "import-dropzone import-dropzone-active"
                    : "import-dropzone"
              }
              disabled={importFilesMutation.isPending || !currentProject}
              onClick={async () => {
                const selected = await open({
                  multiple: true,
                  directory: false,
                  filters: [
                    {
                      name: "KnowledgeOS 支持的资料",
                      extensions: ["md", "txt", "pdf", "pptx", "docx"]
                    }
                  ]
                });
                if (!selected) {
                  return;
                }
                const nextPaths = Array.isArray(selected) ? selected : [selected];
                setImportPaths(nextPaths);
                setImportFeedback(null);
                importFilesMutation.mutate(nextPaths);
              }}
            >
              <div className="import-dropzone-title">
                {importFilesMutation.isPending ? "正在转换资料" : "点击选择资料"}
              </div>
              <div className="import-dropzone-subtitle">
                {importFilesMutation.isPending
                  ? "系统正在自动整理、转换并生成阅读块。完成后会直接进入阅读器。"
                  : "或直接把文件拖到这里。选中文件后会自动导入、转换并进入阅读器。"}
              </div>
              {importFilesMutation.isPending ? (
                <div className="import-processing-stack" aria-hidden="true">
                  <span className="import-processing-card" />
                  <span className="import-processing-card" />
                  <span className="import-processing-card" />
                </div>
              ) : null}
            </button>
            {importPaths.length > 0 ? <div className="import-path-list">
              {importPaths.map((path) => (
                <div key={path} className="import-path-row">
                  <span>{path}</span>
                </div>
              ))}
            </div> : null}
            {importFeedback ? <p className="note-text">{importFeedback}</p> : null}
          </section>
        </aside>

        {currentView === "Agent" ? (
          <AgentWorkspace currentProject={currentProject} />
        ) : currentView === "卡片" ? (
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
          />
        )}
      </section>
      {projectContextMenu ? (
        <div
          className="project-context-menu"
          style={{ left: projectContextMenu.x, top: projectContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          {projectContextMenu.targetType === "project" ? (
            <>
              <button
                className="project-context-item"
                onClick={() => {
                  const targetProject = bootstrap.projects.find((project) => project.projectId === projectContextMenu.projectId);
                  if (!targetProject) {
                    return;
                  }
                  setRenamingProjectId(targetProject.projectId);
                  setRenameDraft(targetProject.name);
                  setProjectContextMenu(null);
                }}
              >
                重命名
              </button>
              <button
                className="project-context-item project-context-item-danger"
                onClick={() =>
                  deleteProjectMutation.mutate({
                    projectId: projectContextMenu.projectId,
                    deleteFiles: true
                  })
                }
              >
                删除项目
              </button>
            </>
          ) : (
            <button
              className="project-context-item project-context-item-danger"
              onClick={() => {
                if (!projectContextMenu.documentId) {
                  return;
                }
                deleteDocumentMutation.mutate({
                  documentId: projectContextMenu.documentId,
                  deleteFiles: true
                });
              }}
            >
              删除文件
            </button>
          )}
        </div>
      ) : null}
    </main>
  );
}

function getDocumentDisplayName(document: Document) {
  const rawName = document.title ?? document.sourcePath.split(/[/\\]/).pop() ?? document.sourcePath;
  return rawName.replace(/^[0-9a-f]{8}[-_]/i, "");
}

function mergeImportPaths(current: string[], incoming: string[]) {
  return Array.from(new Set([...current, ...incoming.map((item) => item.trim()).filter(Boolean)]));
}

function SvgSearchIcon() {
  return (
    <svg className="library-inline-icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="3.8" />
      <path d="M10 10L13 13" />
    </svg>
  );
}

function SvgPlusIcon() {
  return (
    <svg className="library-inline-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3V13" />
      <path d="M3 8H13" />
    </svg>
  );
}

function SvgChevronDownIcon() {
  return (
    <svg className="library-inline-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 6L8 10L12 6" />
    </svg>
  );
}

function SvgChevronRightIcon() {
  return (
    <svg className="library-inline-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 4L10 8L6 12" />
    </svg>
  );
}

function SvgFolderIcon() {
  return (
    <svg className="library-inline-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 5.2H6L7.2 6.4H13.5V12.5H2.5V5.2Z" />
    </svg>
  );
}

function SvgDocumentIcon() {
  return (
    <svg className="library-inline-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 2.5H9.2L12 5.3V13.5H4V2.5Z" />
      <path d="M9 2.8V5.6H11.8" />
    </svg>
  );
}

function SvgCardsIcon() {
  return (
    <svg className="library-inline-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.5" y="4" width="8.5" height="7" />
      <path d="M5 2.5H13.5V9.5" />
    </svg>
  );
}

function SvgGraphIcon() {
  return (
    <svg className="library-inline-icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.5" />
      <circle cx="8" cy="4" r="1.5" />
      <circle cx="12.5" cy="8" r="1.5" />
      <circle cx="8" cy="12" r="1.5" />
      <path d="M4.8 7L6.8 5" />
      <path d="M9.2 5L11.2 7" />
      <path d="M11.2 9L9.2 11" />
      <path d="M6.8 11L4.8 9" />
    </svg>
  );
}

function SvgSparkIcon() {
  return (
    <svg className="library-inline-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.4L9.2 6.8L13.6 8L9.2 9.2L8 13.6L6.8 9.2L2.4 8L6.8 6.8L8 2.4Z" />
    </svg>
  );
}

function SvgBrandMark() {
  return (
    <svg className="brand-mark-icon" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="6.2" />
      <path d="M9 2.8V15.2" />
      <path d="M2.8 9H15.2" />
      <path d="M4.7 4.7L13.3 13.3" />
    </svg>
  );
}
