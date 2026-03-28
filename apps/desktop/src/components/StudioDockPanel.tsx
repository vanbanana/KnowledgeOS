import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Document, Project, StudioArtifact, StudioArtifactKind } from "@knowledgeos/shared-types";
import {
  cancelStudioArtifact,
  createStudioArtifact,
  generateStudioArtifact,
  listStudioArtifacts
} from "../lib/commands/client";

interface StudioDockPanelProps {
  currentProject: Project | null;
  documents: Document[];
  onOpenKnowledgeGraph: (artifactId: string) => void;
  onOpenKnowledgeGraph3D: (artifactId: string) => void;
  onOpenPracticeSet: (artifactId: string) => void;
  onOpenMindMap: (artifactId: string) => void;
  onOpenPresentation: (artifactId: string) => void;
}

interface StudioTileDefinition {
  kind: StudioArtifactKind;
  title: string;
  subtitle: string;
}

interface StudioProgressPreviewPayload {
  excerpt?: string;
  progress?: {
    currentStage?: string;
    details?: string[];
    excerpt?: string;
    updatedAt?: string;
  };
}

const STUDIO_TILES: StudioTileDefinition[] = [
  { kind: "knowledge_graph", title: "GraphRAG知识图谱", subtitle: "问答" },
  { kind: "practice_set", title: "练习题", subtitle: "测验" },
  { kind: "mind_map", title: "思维导图", subtitle: "结构" },
  { kind: "presentation", title: "演示文稿", subtitle: "幻灯" }
];

export function StudioDockPanel({
  currentProject,
  documents,
  onOpenKnowledgeGraph,
  onOpenKnowledgeGraph3D,
  onOpenPracticeSet,
  onOpenMindMap,
  onOpenPresentation
}: StudioDockPanelProps) {
  const queryClient = useQueryClient();
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);

  useEffect(() => {
    setSelectedDocumentIds(documents.slice(0, 6).map((item) => item.documentId));
  }, [currentProject?.projectId, documents]);

  const artifactsQuery = useQuery({
    queryKey: ["studio-artifacts", currentProject?.projectId],
    queryFn: async () => listStudioArtifacts({ projectId: currentProject!.projectId }),
    enabled: Boolean(currentProject?.projectId),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) {
        return 1500;
      }
      return data.artifacts.some((artifact) => !["completed", "failed"].includes(artifact.status)) ? 1200 : 2800;
    }
  });

  const generateArtifactMutation = useMutation({
    mutationFn: async (kind: StudioArtifactKind) => {
      if (!currentProject) {
        throw new Error("请先打开项目");
      }
      if (selectedDocumentIds.length === 0) {
        throw new Error("请先选择至少一份资料");
      }
      const created = await createStudioArtifact({
        projectId: currentProject.projectId,
        kind,
        sourceDocumentIds: selectedDocumentIds
      });
      const generated = await generateStudioArtifact({ artifactId: created.artifact.artifactId });
      return generated.artifact;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["studio-artifacts", currentProject?.projectId] });
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: ["studio-artifacts", currentProject?.projectId] });
    }
  });

  const cancelArtifactMutation = useMutation({
    mutationFn: async (artifactId: string) => cancelStudioArtifact(artifactId),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ["studio-artifacts", currentProject?.projectId] });
    }
  });

  const runningKinds = useMemo(() => {
    return new Set(
      (artifactsQuery.data?.artifacts ?? [])
        .filter((artifact) => !["completed", "failed"].includes(artifact.status))
        .map((artifact) => artifact.kind)
    );
  }, [artifactsQuery.data?.artifacts]);

  const latestArtifacts = useMemo(() => {
    return [...(artifactsQuery.data?.artifacts ?? [])]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 4);
  }, [artifactsQuery.data?.artifacts]);

  return (
    <div className="utility-studio-panel">
      <div className="utility-panel-header utility-panel-header-tight">
        <div>
          <h3>Studio</h3>
          <p>按需生成知识产物</p>
        </div>
      </div>

      <div className="utility-studio-toolbar">
        <div className="utility-panel-section-title">资料范围</div>
        <div className="utility-studio-selection-count">已选 {selectedDocumentIds.length} 份资料</div>
      </div>

      <div className="utility-studio-document-list">
        {documents.slice(0, 8).map((document) => {
          const selected = selectedDocumentIds.includes(document.documentId);
          return (
            <button
              key={document.documentId}
              className={selected ? "utility-studio-doc utility-studio-doc-active" : "utility-studio-doc"}
              onClick={() => {
                setSelectedDocumentIds((current) =>
                  current.includes(document.documentId)
                    ? current.filter((item) => item !== document.documentId)
                    : [...current, document.documentId]
                );
              }}
            >
              <span className="utility-studio-doc-mark">{selected ? "●" : "○"}</span>
              <span className="utility-studio-doc-name">{getDocumentDisplayName(document)}</span>
            </button>
          );
        })}
      </div>

      <div className="utility-studio-entry-block">
        <div className="utility-panel-section-title utility-studio-section-title">生成入口</div>
        <div className="utility-studio-tile-grid">
          {STUDIO_TILES.map((tile) => {
            const running = runningKinds.has(tile.kind) || (generateArtifactMutation.isPending && generateArtifactMutation.variables === tile.kind);
            return (
              <button
                key={tile.kind}
                className={running ? "utility-studio-tile utility-studio-tile-running" : "utility-studio-tile"}
                disabled={!currentProject || selectedDocumentIds.length === 0 || generateArtifactMutation.isPending}
                onClick={() => generateArtifactMutation.mutate(tile.kind)}
              >
                <span className="utility-studio-tile-subtitle">{tile.subtitle}</span>
                <strong className="utility-studio-tile-title">{tile.title}</strong>
                <span className="utility-studio-tile-action">{running ? "生成中" : "开始生成"}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="utility-studio-record-block">
        <div className="utility-panel-section-title utility-studio-section-title">生成记录</div>
        <div className="utility-studio-record-list">
          {latestArtifacts.length === 0 ? (
            <div className="utility-studio-empty">还没有生成记录</div>
          ) : (
            latestArtifacts.map((artifact) => (
              <StudioArtifactRow
                key={artifact.artifactId}
                artifact={artifact}
                cancelling={cancelArtifactMutation.isPending && cancelArtifactMutation.variables === artifact.artifactId}
                onCancel={(artifactId) => cancelArtifactMutation.mutate(artifactId)}
                onOpenKnowledgeGraph={onOpenKnowledgeGraph}
                onOpenKnowledgeGraph3D={onOpenKnowledgeGraph3D}
                onOpenPracticeSet={onOpenPracticeSet}
                onOpenMindMap={onOpenMindMap}
                onOpenPresentation={onOpenPresentation}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function StudioArtifactRow({
  artifact,
  cancelling,
  onCancel,
  onOpenKnowledgeGraph,
  onOpenKnowledgeGraph3D,
  onOpenPracticeSet,
  onOpenMindMap,
  onOpenPresentation
}: {
  artifact: StudioArtifact;
  cancelling: boolean;
  onCancel: (artifactId: string) => void;
  onOpenKnowledgeGraph: (artifactId: string) => void;
  onOpenKnowledgeGraph3D: (artifactId: string) => void;
  onOpenPracticeSet: (artifactId: string) => void;
  onOpenMindMap: (artifactId: string) => void;
  onOpenPresentation: (artifactId: string) => void;
}) {
  const preview = useMemo(() => parseStudioProgressPreview(artifact.previewJson), [artifact.previewJson]);
  const detailLines = preview?.progress?.details ?? [];
  const detailExcerpt = preview?.progress?.excerpt ?? preview?.excerpt ?? "";
  const stageText = preview?.progress?.currentStage ?? artifact.currentStage ?? "等待开始";

  const openArtifact = () => {
    if (artifact.kind === "knowledge_graph") {
      onOpenKnowledgeGraph(artifact.artifactId);
      return;
    }
    if (artifact.kind === "knowledge_graph_3d") {
      onOpenKnowledgeGraph3D(artifact.artifactId);
      return;
    }
    if (artifact.kind === "practice_set") {
      onOpenPracticeSet(artifact.artifactId);
      return;
    }
    if (artifact.kind === "mind_map") {
      onOpenMindMap(artifact.artifactId);
      return;
    }
    if (artifact.kind === "presentation") {
      onOpenPresentation(artifact.artifactId);
    }
  };

  return (
    <div className={artifact.status === "completed" || artifact.status === "failed" ? "utility-studio-record-row" : "utility-studio-record-row utility-studio-record-row-running"}>
      <div className="utility-studio-record-copy">
        <div className="utility-studio-record-title">{getArtifactDisplayTitle(artifact)}</div>
        <div className="utility-studio-record-meta">
          <span>{mapKindLabel(artifact.kind)}</span>
          <span>{artifact.progressPercent}%</span>
          <span>{mapStatusLabel(artifact.status)}</span>
        </div>
        <div className="utility-studio-record-stage">{stageText}</div>
        {detailLines.length > 0 ? (
          <div className="utility-studio-record-detail-list">
            {detailLines.slice(-4).map((line, index) => (
              <span key={`${artifact.artifactId}-detail-${index}`} className="utility-studio-record-detail-line">
                {line}
              </span>
            ))}
          </div>
        ) : null}
        {detailExcerpt ? <div className="utility-studio-record-excerpt">{detailExcerpt}</div> : null}
        {artifact.status === "failed" && artifact.errorMessage ? (
          <div className="utility-studio-record-error">{artifact.errorMessage}</div>
        ) : null}
        {artifact.status !== "completed" && artifact.status !== "failed" ? (
          <div className="utility-studio-record-progress">
            <div className="utility-studio-record-progress-bar">
              <span style={{ width: `${Math.max(8, artifact.progressPercent)}%` }} />
            </div>
            <div className="utility-studio-record-progress-meta">
              <span>{stageText}</span>
              <span>{artifact.progressPercent}%</span>
            </div>
          </div>
        ) : null}
      </div>
      {artifact.status === "completed" ? (
        <button className="utility-studio-open-button" onClick={openArtifact}>打开</button>
      ) : artifact.status === "failed" ? (
        <span className="utility-studio-status-text utility-studio-status-failed">失败</span>
      ) : (
        <button className="utility-studio-open-button" disabled={cancelling} onClick={() => onCancel(artifact.artifactId)}>
          {cancelling ? "停止中" : "停止"}
        </button>
      )}
    </div>
  );
}

function mapKindLabel(kind: StudioArtifactKind) {
  switch (kind) {
    case "knowledge_graph":
      return "GraphRAG知识图谱";
    case "knowledge_graph_3d":
      return "3D知识可视化";
    case "practice_set":
      return "练习题";
    case "mind_map":
      return "思维导图";
    case "presentation":
      return "演示文稿";
    default:
      return kind;
  }
}

function mapStatusLabel(status: StudioArtifact["status"]) {
  switch (status) {
    case "queued":
      return "排队中";
    case "preparing":
      return "准备中";
    case "generating":
      return "生成中";
    case "materializing":
      return "写入中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    default:
      return status;
  }
}

function getArtifactDisplayTitle(artifact: StudioArtifact) {
  if (artifact.kind === "knowledge_graph") {
    return artifact.title.replace(/^知识图谱网络/, "GraphRAG知识图谱");
  }
  if (artifact.kind === "knowledge_graph_3d") {
    return artifact.title.replace(/^3D 知识星图/, "3D知识可视化");
  }
  return artifact.title;
}

function getDocumentDisplayName(document: Document) {
  const rawName = document.title ?? document.sourcePath.split(/[\\/]/).pop() ?? document.sourcePath;
  return rawName.replace(/^[0-9a-f]{8}[-_]/i, "");
}

function parseStudioProgressPreview(previewJson: string | null): StudioProgressPreviewPayload | null {
  if (!previewJson) {
    return null;
  }
  try {
    return JSON.parse(previewJson) as StudioProgressPreviewPayload;
  } catch {
    return null;
  }
}
