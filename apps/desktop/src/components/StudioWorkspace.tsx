import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from "d3-force";
import type { Document, Project, StudioArtifact, StudioArtifactKind } from "@knowledgeos/shared-types";
import {
  createStudioArtifact,
  generateStudioArtifact,
  getStudioArtifact,
  listStudioArtifacts
} from "../lib/commands/client";

interface StudioWorkspaceProps {
  currentProject: Project | null;
  documents: Document[];
  onOpenKnowledgeGraph: (artifactId: string) => void;
  onOpenPracticeSet: (artifactId: string) => void;
  onOpenMindMap: (artifactId: string) => void;
  onOpenPresentation: (artifactId: string) => void;
}

interface StudioTileDefinition {
  kind: StudioArtifactKind;
  title: string;
  subtitle: string;
  description: string;
  toneClassName: string;
}

interface StudioGraphPreviewNode {
  id: string;
  label: string;
  weight: number;
}

interface StudioGraphPreviewLink {
  source: string;
  target: string;
}

interface StudioGraphSimulationNode extends SimulationNodeDatum, StudioGraphPreviewNode {
  x: number;
  y: number;
}

interface StudioGraphSimulationLink extends SimulationLinkDatum<StudioGraphSimulationNode> {
  source: string | StudioGraphSimulationNode;
  target: string | StudioGraphSimulationNode;
}

interface StudioPreviewPayload {
  excerpt?: string;
  lineCount?: number;
  graph?: {
    nodes: StudioGraphPreviewNode[];
    links: StudioGraphPreviewLink[];
  };
  practiceSet?: {
    items: Array<{
      question: string;
      answer: string;
      explanation: string;
    }>;
  };
  mindMap?: {
    nodes: Array<{
      depth: number;
      label: string;
    }>;
  };
  presentation?: {
    slides: Array<{
      title: string;
      lines: string[];
    }>;
  };
}

const STUDIO_TILES: StudioTileDefinition[] = [
  {
    kind: "knowledge_graph",
    title: "GraphRAG知识图谱",
    subtitle: "图谱问答",
    description: "基于现有知识卡片和关系网络，进入可问答的 GraphRAG 图谱页。",
    toneClassName: "studio-tile-graph"
  },
  {
    kind: "practice_set",
    title: "练习题",
    subtitle: "学习巩固",
    description: "生成带答案和解析的练习题草稿。",
    toneClassName: "studio-tile-practice"
  },
  {
    kind: "mind_map",
    title: "思维导图",
    subtitle: "知识梳理",
    description: "输出 Mermaid mindmap，快速梳理主题层级。",
    toneClassName: "studio-tile-mindmap"
  },
  {
    kind: "presentation",
    title: "演示文稿",
    subtitle: "PPTX 文件",
    description: "直接生成可打开使用的 PPTX 演示文稿文件。",
    toneClassName: "studio-tile-presentation"
  }
];

export function StudioWorkspace({
  currentProject,
  documents,
  onOpenKnowledgeGraph,
  onOpenPracticeSet,
  onOpenMindMap,
  onOpenPresentation
}: StudioWorkspaceProps) {
  const queryClient = useQueryClient();
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedDocumentIds(documents.slice(0, 3).map((item) => item.documentId));
  }, [currentProject?.projectId]);

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

  const selectedArtifact = useMemo(() => {
    if (!selectedArtifactId) {
      return artifactsQuery.data?.artifacts[0] ?? null;
    }
    return artifactsQuery.data?.artifacts.find((artifact) => artifact.artifactId === selectedArtifactId) ?? null;
  }, [artifactsQuery.data?.artifacts, selectedArtifactId]);

  useEffect(() => {
    if (!selectedArtifactId && artifactsQuery.data?.artifacts.length) {
      setSelectedArtifactId(artifactsQuery.data.artifacts[0].artifactId);
    }
  }, [artifactsQuery.data?.artifacts, selectedArtifactId]);

  const generateArtifactMutation = useMutation({
    mutationFn: async (kind: StudioArtifactKind) => {
      if (!currentProject) {
        throw new Error("请先打开项目。");
      }
      if (selectedDocumentIds.length === 0) {
        throw new Error("请先选择至少一份资料。");
      }
      const created = await createStudioArtifact({
        projectId: currentProject.projectId,
        kind,
        sourceDocumentIds: selectedDocumentIds
      });
      setSelectedArtifactId(created.artifact.artifactId);
      const generated = await generateStudioArtifact({ artifactId: created.artifact.artifactId });
      return generated.artifact;
    },
    onSuccess: async (artifact) => {
      setSelectedArtifactId(artifact.artifactId);
      await queryClient.invalidateQueries({ queryKey: ["studio-artifacts", currentProject?.projectId] });
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: ["studio-artifacts", currentProject?.projectId] });
    }
  });

  const selectedArtifactQuery = useQuery({
    queryKey: ["studio-artifact", selectedArtifact?.artifactId],
    queryFn: async () => getStudioArtifact(selectedArtifact!.artifactId),
    enabled: Boolean(selectedArtifact?.artifactId),
    refetchInterval: (query) => {
      const artifact = query.state.data?.artifact;
      if (!artifact) {
        return 0;
      }
      return ["completed", "failed"].includes(artifact.status) ? 0 : 1000;
    }
  });

  const artifactDetail = selectedArtifactQuery.data?.artifact ?? selectedArtifact;
  const selectionSummary =
    selectedDocumentIds.length > 0
      ? `已选择 ${selectedDocumentIds.length} 份资料`
      : "请选择要参与生成的资料";

  return (
    <section className="workspace-grid studio-workspace-grid">
      <aside className="workspace-sidepanel studio-sidepanel">
        <div className="workspace-panel-title">Studio 资料范围</div>
        <div className="studio-selection-summary">{selectionSummary}</div>
        <div className="workspace-list studio-document-selector">
          {documents.map((document) => {
            const selected = selectedDocumentIds.includes(document.documentId);
            return (
              <button
                key={document.documentId}
                className={selected ? "studio-document-chip studio-document-chip-active" : "studio-document-chip"}
                onClick={() => {
                  setSelectedDocumentIds((current) =>
                    current.includes(document.documentId)
                      ? current.filter((item) => item !== document.documentId)
                      : [...current, document.documentId]
                  );
                }}
              >
                <span className="studio-document-chip-mark">{selected ? "●" : "○"}</span>
                <span className="studio-document-chip-name">{getDocumentDisplayName(document)}</span>
              </button>
            );
          })}
        </div>
      </aside>

      <section className="workspace-editor studio-editor">
        <header className="studio-header">
          <div>
            <div className="workspace-panel-title">Studio</div>
            <h2 className="studio-title">按需生成知识产物</h2>
            <p className="studio-description">资料导入后不会自动生成。只有在你明确选择生成类型时，系统才会开始处理。</p>
          </div>
        </header>

        <div className="studio-grid">
          {STUDIO_TILES.map((tile) => (
            <button
              key={tile.kind}
              className={`studio-tile ${tile.toneClassName}`}
              onClick={() => generateArtifactMutation.mutate(tile.kind)}
              disabled={!currentProject || selectedDocumentIds.length === 0 || generateArtifactMutation.isPending}
            >
              <div className="studio-tile-copy">
                <span className="studio-tile-subtitle">{tile.subtitle}</span>
                <strong className="studio-tile-title">{tile.title}</strong>
                <span className="studio-tile-description">{tile.description}</span>
              </div>
              <span className="studio-tile-arrow">
                <SvgArrowRightIcon />
              </span>
            </button>
          ))}
        </div>

        <div className="studio-run-header">
          <div className="workspace-panel-title">生成记录</div>
          {artifactsQuery.isFetching ? <span className="studio-fetching-state">正在同步</span> : null}
        </div>
        <div className="studio-artifact-list">
          {(artifactsQuery.data?.artifacts ?? []).map((artifact) => (
            <button
              key={artifact.artifactId}
              className={artifact.artifactId === artifactDetail?.artifactId ? "studio-artifact-card studio-artifact-card-active" : "studio-artifact-card"}
              onClick={() => setSelectedArtifactId(artifact.artifactId)}
            >
              <div className="studio-artifact-card-head">
                <strong>{getArtifactDisplayTitle(artifact)}</strong>
                <span className={`studio-status-chip studio-status-${artifact.status}`}>{mapStatusLabel(artifact.status)}</span>
              </div>
              <div className="studio-artifact-card-meta">
                <span>{mapKindLabel(artifact.kind)}</span>
                <span>{artifact.progressPercent}%</span>
              </div>
              <div className="studio-artifact-progress-track">
                <div className="studio-artifact-progress-fill" style={{ width: `${artifact.progressPercent}%` }} />
              </div>
              <p className="studio-artifact-stage">{artifact.currentStage ?? "等待开始"}</p>
            </button>
          ))}
          {artifactsQuery.data?.artifacts.length ? null : <div className="workspace-generic-empty">还没有生成任何产物</div>}
        </div>
      </section>

      <aside className="workspace-preview studio-preview">
        <div className="workspace-panel-title">当前进度</div>
        {artifactDetail ? (
          <StudioArtifactDetail
            artifact={artifactDetail}
            onOpenKnowledgeGraph={onOpenKnowledgeGraph}
            onOpenPracticeSet={onOpenPracticeSet}
            onOpenMindMap={onOpenMindMap}
            onOpenPresentation={onOpenPresentation}
          />
        ) : (
          <div className="workspace-generic-empty">选择一种产物后，这里会显示详细进度</div>
        )}
      </aside>
    </section>
  );
}

function StudioArtifactDetail({
  artifact,
  onOpenKnowledgeGraph,
  onOpenPracticeSet,
  onOpenMindMap,
  onOpenPresentation
}: {
  artifact: StudioArtifact;
  onOpenKnowledgeGraph: (artifactId: string) => void;
  onOpenPracticeSet: (artifactId: string) => void;
  onOpenMindMap: (artifactId: string) => void;
  onOpenPresentation: (artifactId: string) => void;
}) {
  const preview = useMemo(() => {
    if (!artifact.previewJson) {
      return null;
    }
    try {
      return JSON.parse(artifact.previewJson) as StudioPreviewPayload;
    } catch {
      return null;
    }
  }, [artifact.previewJson]);

  return (
    <div className="studio-detail-card">
      <div className="studio-detail-head">
        <strong>{getArtifactDisplayTitle(artifact)}</strong>
        <span className={`studio-status-chip studio-status-${artifact.status}`}>{mapStatusLabel(artifact.status)}</span>
      </div>
      <div className="studio-detail-kind">{mapKindLabel(artifact.kind)}</div>
      <div className="studio-detail-progress">
        <div className="studio-detail-progress-shell">
          <div className="studio-detail-progress-bar" style={{ width: `${artifact.progressPercent}%` }} />
        </div>
        <div className="studio-detail-progress-meta">
          <span>{artifact.currentStage ?? "等待开始"}</span>
          <span>{artifact.progressPercent}%</span>
        </div>
      </div>
      {!["completed", "failed"].includes(artifact.status) ? <div className="studio-shimmer-line" aria-hidden="true" /> : null}
      {artifact.outputPath ? (
        <div className="studio-detail-row">
          <span className="studio-detail-label">输出位置</span>
          <span className="studio-detail-value">{toRelativeOutputPath(artifact.outputPath)}</span>
        </div>
      ) : null}
      {preview?.lineCount ? (
        <div className="studio-detail-row">
          <span className="studio-detail-label">结果规模</span>
          <span className="studio-detail-value">{preview.lineCount} 行</span>
        </div>
      ) : null}
      <div className="studio-detail-actions">
        {artifact.kind === "knowledge_graph" ? (
          <button className="small-button studio-open-graph-button" onClick={() => onOpenKnowledgeGraph(artifact.artifactId)}>
                  打开 GraphRAG 图谱页
          </button>
        ) : null}
        {artifact.kind === "practice_set" ? (
          <button className="small-button studio-open-graph-button" onClick={() => onOpenPracticeSet(artifact.artifactId)}>
            打开练习题工作台
          </button>
        ) : null}
        {artifact.kind === "mind_map" ? (
          <button className="small-button studio-open-graph-button" onClick={() => onOpenMindMap(artifact.artifactId)}>
            打开思维导图工作台
          </button>
        ) : null}
        {artifact.kind === "presentation" ? (
          <button className="small-button studio-open-graph-button" onClick={() => onOpenPresentation(artifact.artifactId)}>
            打开演示文稿工作台
          </button>
        ) : null}
      </div>
      {artifact.kind === "knowledge_graph" && preview?.graph ? (
        <StudioKnowledgeGraphPreview graph={preview.graph} />
      ) : null}
      {artifact.kind === "practice_set" && preview?.practiceSet ? (
        <StudioPracticeSetPreview practiceSet={preview.practiceSet} />
      ) : null}
      {artifact.kind === "mind_map" && preview?.mindMap ? (
        <StudioMindMapPreview mindMap={preview.mindMap} />
      ) : null}
      {artifact.kind === "presentation" && preview?.presentation ? (
        <StudioPresentationPreview presentation={preview.presentation} />
      ) : null}
      {artifact.errorMessage ? (
        <div className="studio-detail-error">{artifact.errorMessage}</div>
      ) : preview?.excerpt && !preview.practiceSet && !preview.mindMap && !preview.presentation ? (
        <pre className="studio-preview-excerpt">{preview.excerpt}</pre>
      ) : (
        <div className="studio-preview-placeholder">生成完成后，这里会显示结果摘要。</div>
      )}
    </div>
  );
}

function StudioPracticeSetPreview({
  practiceSet
}: {
  practiceSet: NonNullable<StudioPreviewPayload["practiceSet"]>;
}) {
  return (
    <div className="studio-render-shell">
      <div className="studio-detail-row">
        <span className="studio-detail-label">练习题预览</span>
        <span className="studio-detail-value">{practiceSet.items.length} 题</span>
      </div>
      <div className="studio-practice-list">
        {practiceSet.items.slice(0, 5).map((item, index) => (
          <div key={`${item.question}-${index}`} className="studio-practice-item">
            <strong>{item.question}</strong>
            {item.answer ? <span>{item.answer}</span> : null}
            {item.explanation ? <p>{item.explanation}</p> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function StudioMindMapPreview({
  mindMap
}: {
  mindMap: NonNullable<StudioPreviewPayload["mindMap"]>;
}) {
  return (
    <div className="studio-render-shell">
      <div className="studio-detail-row">
        <span className="studio-detail-label">思维导图预览</span>
        <span className="studio-detail-value">{mindMap.nodes.length} 个节点</span>
      </div>
      <div className="studio-mindmap-tree">
        {mindMap.nodes.slice(0, 18).map((node, index) => (
          <div key={`${node.label}-${index}`} className="studio-mindmap-node" style={{ paddingLeft: `${node.depth * 18}px` }}>
            <span className="studio-mindmap-dot" />
            <span>{node.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StudioPresentationPreview({
  presentation
}: {
  presentation: NonNullable<StudioPreviewPayload["presentation"]>;
}) {
  return (
    <div className="studio-render-shell">
      <div className="studio-detail-row">
        <span className="studio-detail-label">演示文稿预览</span>
        <span className="studio-detail-value">{presentation.slides.length} 页</span>
      </div>
      <div className="studio-slide-list">
        {presentation.slides.slice(0, 4).map((slide, index) => (
          <div key={`${slide.title}-${index}`} className="studio-slide-card">
            <strong>{slide.title.replace(/^#+\s*/, "")}</strong>
            <ul>
              {slide.lines.slice(1, 5).map((line, lineIndex) => (
                <li key={`${line}-${lineIndex}`}>{line.replace(/^[-*]\s*/, "")}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function StudioKnowledgeGraphPreview({ graph }: { graph: NonNullable<StudioPreviewPayload["graph"]> }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 320, height: 260 });
  const [layout, setLayout] = useState(() => ({
    nodes: graph.nodes.map((node, index): StudioGraphSimulationNode => ({
      ...node,
      x: 80 + (index % 4) * 54,
      y: 80 + Math.floor(index / 4) * 42
    })),
    links: graph.links as StudioGraphSimulationLink[]
  }));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const syncSize = () => {
      const nextWidth = Math.max(260, Math.floor(host.clientWidth));
      setSize({
        width: nextWidth,
        height: Math.max(240, Math.min(420, Math.round(nextWidth * 0.72)))
      });
    };

    syncSize();
    const observer = new ResizeObserver(syncSize);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const simulationNodes: StudioGraphSimulationNode[] = graph.nodes.map((node, index) => ({
      ...node,
      x: 64 + (index % 4) * 56,
      y: 64 + Math.floor(index / 4) * 48
    }));
    const simulationLinks: StudioGraphSimulationLink[] = graph.links.map((link) => ({ ...link }));

    let frame = 0;
    const simulation = forceSimulation(simulationNodes)
      .force(
        "link",
        forceLink<StudioGraphSimulationNode, StudioGraphSimulationLink>(simulationLinks)
          .id((node: StudioGraphSimulationNode) => node.id)
          .distance((link) => {
            const sourceWeight = typeof link.source === "object" ? link.source.weight : 1;
            const targetWeight = typeof link.target === "object" ? link.target.weight : 1;
            return 84 + (sourceWeight + targetWeight) * 6;
          })
          .strength(0.42)
      )
      .force("charge", forceManyBody<StudioGraphSimulationNode>().strength((node: StudioGraphSimulationNode) => -160 - node.weight * 28))
      .force("center", forceCenter<StudioGraphSimulationNode>(size.width / 2, size.height / 2))
      .force("collide", forceCollide<StudioGraphSimulationNode>((node: StudioGraphSimulationNode) => 18 + Math.min(node.weight, 6) * 3))
      .alphaDecay(0.035);

    const flushLayout = () => {
      frame = 0;
      setLayout({
        nodes: simulationNodes.map((node) => ({
          ...node,
          x: clamp(node.x, 28, size.width - 28),
          y: clamp(node.y, 28, size.height - 28)
        })),
        links: simulationLinks
      });
    };

    simulation.on("tick", () => {
      if (frame !== 0) {
        return;
      }
      frame = window.requestAnimationFrame(flushLayout);
    });

    simulation.on("end", () => {
      if (frame === 0) {
        flushLayout();
      }
    });

    return () => {
      simulation.stop();
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [graph, size.height, size.width]);

  const positionedNodeMap = new Map(layout.nodes.map((node) => [node.id, node]));
  const highlightedNodeIds = new Set<string>();
  if (hoveredNodeId) {
    highlightedNodeIds.add(hoveredNodeId);
  }
  for (const link of layout.links) {
    const sourceId = typeof link.source === "string" ? link.source : link.source.id;
    const targetId = typeof link.target === "string" ? link.target : link.target.id;
    if (hoveredNodeId && (sourceId === hoveredNodeId || targetId === hoveredNodeId)) {
      highlightedNodeIds.add(sourceId);
      highlightedNodeIds.add(targetId);
    }
  }

  return (
    <div className="studio-graph-preview-shell">
      <div className="studio-detail-row">
        <span className="studio-detail-label">网络预览</span>
        <span className="studio-detail-value">
          {graph.nodes.length} 个节点 · {graph.links.length} 条连接
        </span>
      </div>
        <div ref={hostRef} className="studio-graph-preview">
          <svg viewBox={`0 0 ${size.width} ${size.height}`} className="studio-graph-svg" aria-label="GraphRAG知识图谱预览">
          <defs>
            <linearGradient id={`studio-graph-flow-${graph.nodes.length}-${graph.links.length}`} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="rgba(255,255,255,0)" />
              <stop offset="50%" stopColor="rgba(255,255,255,0.75)" />
              <stop offset="100%" stopColor="rgba(255,255,255,0)" />
            </linearGradient>
          </defs>
          {layout.links.map((link, index) => {
            const sourceId = typeof link.source === "string" ? link.source : link.source.id;
            const targetId = typeof link.target === "string" ? link.target : link.target.id;
            const source = positionedNodeMap.get(sourceId);
            const target = positionedNodeMap.get(targetId);
            if (!source || !target) {
              return null;
            }
            const gradientId = `studio-graph-flow-${graph.nodes.length}-${graph.links.length}`;
            const highlighted = hoveredNodeId && (sourceId === hoveredNodeId || targetId === hoveredNodeId);
            return (
              <g key={`${sourceId}-${targetId}-${index}`}>
                <line x1={source.x} y1={source.y} x2={target.x} y2={target.y} className={highlighted ? "studio-graph-link studio-graph-link-active" : "studio-graph-link"} />
                <line
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  className={highlighted ? "studio-graph-link-flow studio-graph-link-flow-active" : "studio-graph-link-flow"}
                  stroke={`url(#${gradientId})`}
                />
              </g>
            );
          })}
          {layout.nodes.map((node) => {
            const radius = getStudioGraphRadius(node);
            const emphasized = highlightedNodeIds.has(node.id) || isStudioGraphHub(node.label);
            return (
              <g
                key={node.id}
                transform={`translate(${node.x}, ${node.y})`}
                className="studio-graph-node-group"
                onMouseEnter={() => setHoveredNodeId(node.id)}
                onMouseLeave={() => setHoveredNodeId(null)}
                >
                  <circle r={radius} className={getStudioGraphNodeClass(node)} />
                  {emphasized ? (
                    <text textAnchor="middle" y={radius + 16} className="studio-graph-node-label">
                      {truncateStudioGraphLabel(node.label)}
                    </text>
                  ) : null}
                </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function getDocumentDisplayName(document: Document) {
  const rawName = document.title ?? document.sourcePath.split(/[/\\]/).pop() ?? document.sourcePath;
  return rawName.replace(/^[0-9a-f]{8}[-_]/i, "");
}

function mapKindLabel(kind: StudioArtifactKind) {
  switch (kind) {
    case "knowledge_graph":
      return "GraphRAG知识图谱";
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

function toRelativeOutputPath(outputPath: string) {
  const normalized = outputPath.replace(/\\/g, "/");
  const index = normalized.indexOf("/exports/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function getStudioGraphRadius(node: StudioGraphPreviewNode) {
  if (isStudioGraphHub(node.label)) {
    return 22;
  }
  return 12 + Math.min(node.weight, 6) * 2;
}

function getStudioGraphNodeClass(node: StudioGraphPreviewNode) {
  return isStudioGraphHub(node.label) ? "studio-graph-node studio-graph-node-hub" : "studio-graph-node";
}

function isStudioGraphHub(label: string) {
  return /readme|index|总结|总览|概述/i.test(label);
}

function truncateStudioGraphLabel(label: string) {
  return label.length > 8 ? `${label.slice(0, 8)}…` : label;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function SvgArrowRightIcon() {
  return (
    <svg className="library-inline-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 3.5L10 8L5 12.5" />
    </svg>
  );
}
