import { startTransition, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import ForceGraph3D from "react-force-graph-3d";
import SpriteText from "three-spritetext";
import type { GraphRagEvidence, Project } from "@knowledgeos/shared-types";
import {
  getStudioArtifact,
  getSubgraph,
  graphRagQuery,
  listStudioArtifacts,
} from "../lib/commands/client";
import { MarkdownArticle } from "./MarkdownArticle";

interface Graph3DWorkspaceProps {
  currentProject: Project | null;
  selectedArtifactId?: string | null;
  onSelectArtifact?: (artifactId: string) => void;
  onJumpToBlock: (blockId: string) => void;
}

interface GraphChatMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
  evidence?: GraphRagEvidence[];
  isStreaming?: boolean;
}

interface GraphViewportNode {
  id: string;
  nodeId: string;
  label: string;
  nodeType: string;
  sourceRef: string | null;
  weight: number;
  x?: number;
  y?: number;
  z?: number;
}

interface GraphViewportLink {
  relationId: string;
  source: string;
  target: string;
  relationType: string;
  color: string;
  confirmedByUser: boolean;
  sourceRef: string | null;
}

interface StudioPreviewGraph {
  nodes: Array<{
    id: string;
    label: string;
    weight: number;
  }>;
  links: Array<{
    source: string;
    target: string;
  }>;
}

interface NodeRelationRow {
  relationId: string;
  relationType: string;
  directionLabel: "输入" | "输出";
  sourceRef: string | null;
  confirmedByUser: boolean;
}

interface NodeRelationTypeGroup {
  key: string;
  categoryKey: string;
  categoryLabel: string;
  categoryOrder: number;
  relationType: string;
  rows: NodeRelationRow[];
}

interface NodeRelationPairGroup {
  targetNodeId: string;
  targetNodeLabel: string;
  directionLabel: "输入" | "输出" | "双向";
  relationCount: number;
  typeGroups: NodeRelationTypeGroup[];
}

interface RelationCategoryTotal {
  key: string;
  label: string;
  order: number;
  count: number;
}

export function Graph3DWorkspace({
  currentProject,
  selectedArtifactId = null,
  onSelectArtifact,
  onJumpToBlock
}: Graph3DWorkspaceProps) {
  const graphRef = useRef<any>(null);
  const fitPaddingRef = useRef(72);
  const engineFitPendingRef = useRef(true);
  const canvasRegionRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chatBodyRef = useRef<HTMLDivElement | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [size, setSize] = useState({ width: 1200, height: 720 });
  const [viewportWidth, setViewportWidth] = useState(1440);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [graphQuestion, setGraphQuestion] = useState("");
  const [chatMessages, setChatMessages] = useState<GraphChatMessage[]>([]);
  const [chatDrawerOpen, setChatDrawerOpen] = useState(false);
  const [relationsDrawerOpen, setRelationsDrawerOpen] = useState(false);

  const subgraphQuery = useQuery({
    queryKey: ["graph-3d", currentProject?.projectId],
    queryFn: async () =>
      getSubgraph({
        projectId: currentProject!.projectId,
        nodeTypes: [],
        queryText: undefined,
        relationConfirmedOnly: false
      }),
    enabled: Boolean(currentProject?.projectId)
  });

  const artifactsQuery = useQuery({
    queryKey: ["graph-3d-artifacts", currentProject?.projectId],
    queryFn: async () => listStudioArtifacts({ projectId: currentProject!.projectId }),
    enabled: Boolean(currentProject?.projectId)
  });

  const liveNodes = subgraphQuery.data?.subgraph.nodes ?? [];
  const liveRelations = subgraphQuery.data?.subgraph.relations ?? [];

  const preferredArtifact = useMemo(() => {
    if (!selectedArtifactId) {
      return null;
    }
    const artifacts = artifactsQuery.data?.artifacts ?? [];
    return artifacts.find((item) => item.artifactId === selectedArtifactId) ?? null;
  }, [artifactsQuery.data?.artifacts, selectedArtifactId]);

  const fallbackArtifact = useMemo(() => {
    const artifacts = artifactsQuery.data?.artifacts ?? [];
    return preferredArtifact
      ?? artifacts.find((item) => item.status === "completed" && item.kind === "knowledge_graph_3d")
      ?? artifacts.find((item) => item.status === "completed" && item.kind === "knowledge_graph")
      ?? null;
  }, [artifactsQuery.data?.artifacts, preferredArtifact]);

  const fallbackArtifactQuery = useQuery({
    queryKey: ["graph-3d-artifact", fallbackArtifact?.artifactId],
    queryFn: async () => getStudioArtifact(fallbackArtifact!.artifactId),
    enabled: Boolean(fallbackArtifact?.artifactId)
  });

  const fallbackPreview = useMemo(
    () => parseStudioGraphPreview(fallbackArtifactQuery.data?.artifact?.previewJson ?? fallbackArtifact?.previewJson ?? null),
    [fallbackArtifact?.previewJson, fallbackArtifactQuery.data?.artifact?.previewJson]
  );

  useEffect(() => {
    if (!fallbackArtifact?.artifactId || selectedArtifactId || !onSelectArtifact) {
      return;
    }
    onSelectArtifact(fallbackArtifact.artifactId);
  }, [fallbackArtifact?.artifactId, onSelectArtifact, selectedArtifactId]);

  const hasLiveGraph = liveNodes.length > 0 && liveRelations.length > 0;

  const displayNodes = useMemo<GraphViewportNode[]>(() => {
    if (hasLiveGraph) {
      return liveNodes.map((node) => ({
        id: node.nodeId,
        nodeId: node.nodeId,
        label: node.label,
        nodeType: node.nodeType,
        sourceRef: node.sourceRef,
        weight: 1
      }));
    }
    return (fallbackPreview?.nodes ?? []).map((node) => ({
      id: node.id,
      nodeId: node.id,
      label: node.label,
      nodeType: "概念",
      sourceRef: null,
      weight: node.weight
    }));
  }, [fallbackPreview?.nodes, hasLiveGraph, liveNodes]);

  const displayRelations = useMemo<GraphViewportLink[]>(() => {
    if (hasLiveGraph) {
      return liveRelations.map((relation) => ({
        relationId: relation.relationId,
        source: relation.fromNodeId,
        target: relation.toNodeId,
        relationType: relation.relationType,
        color: "#516584",
        confirmedByUser: relation.confirmedByUser,
        sourceRef: relation.sourceRef
      }));
    }
    return (fallbackPreview?.links ?? []).map((relation, index) => ({
      relationId: `preview-${relation.source}-${relation.target}-${index}`,
      source: relation.source,
      target: relation.target,
      relationType: "关联",
      color: "#516584",
      confirmedByUser: true,
      sourceRef: null
    }));
  }, [fallbackPreview?.links, hasLiveGraph, liveRelations]);

  const nodeLabelMap = useMemo(
    () => new Map(displayNodes.map((item) => [item.nodeId, item.label])),
    [displayNodes]
  );

  const currentNode = useMemo(
    () => displayNodes.find((item) => item.nodeId === selectedNodeId) ?? displayNodes[0] ?? null,
    [displayNodes, selectedNodeId]
  );

  useEffect(() => {
    if (currentNode && currentNode.nodeId !== selectedNodeId) {
      setSelectedNodeId(currentNode.nodeId);
    }
  }, [currentNode, selectedNodeId]);

  useEffect(() => {
    const region = canvasRegionRef.current;
    if (!region) {
      return;
    }
    const syncViewportWidth = () => {
      setViewportWidth(Math.max(320, Math.floor(region.clientWidth)));
    };
    syncViewportWidth();
    const observer = new ResizeObserver(syncViewportWidth);
    observer.observe(region);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const syncSize = () => {
      setSize({
        width: Math.max(320, Math.floor(host.clientWidth)),
        height: Math.max(280, Math.floor(host.clientHeight))
      });
    };
    syncSize();
    const observer = new ResizeObserver(syncSize);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const graphRagMutation = useMutation({
    mutationFn: async ({ question }: { requestId: string; question: string }) =>
      graphRagQuery({
        projectId: currentProject!.projectId,
        query: question,
        focusNodeId: selectedNodeId ?? undefined,
        history: chatMessages.map((item) => ({
          role: item.role,
          content: item.content
        }))
      }),
    onSuccess: (result, variables) => {
      startTransition(() => {
        setChatMessages((current) =>
          current.map((message) =>
            message.id === `assistant-${variables.requestId}`
              ? {
                  ...message,
                  content: result.answer,
                  evidence: result.evidence,
                  isStreaming: false
                }
              : message
          )
        );
        setGraphQuestion("");
      });
    },
    onError: (error, variables) => {
      startTransition(() => {
        setChatMessages((current) =>
          current.map((message) =>
            message.id === `assistant-${variables.requestId}`
              ? {
                  ...message,
                  content: `请求失败：${error.message}`,
                  isStreaming: false
                }
              : message
          )
        );
      });
    }
  });

  const nodeDegreeMap = useMemo(() => {
    const degreeMap = new Map<string, number>();
    for (const relation of displayRelations) {
      degreeMap.set(relation.source, (degreeMap.get(relation.source) ?? 0) + 1);
      degreeMap.set(relation.target, (degreeMap.get(relation.target) ?? 0) + 1);
    }
    return degreeMap;
  }, [displayRelations]);

  const graphData = useMemo(() => {
    return {
      nodes: displayNodes.map((node) => {
        const degree = nodeDegreeMap.get(node.nodeId) ?? 1;
        return {
          ...node,
          weight: Math.max(node.weight, degree)
        };
      }),
      // ForceGraph 会就地改写 source/target，必须复制，避免污染业务数据并导致连线错乱。
      links: displayRelations.map((relation) => ({ ...relation }))
    };
  }, [displayNodes, displayRelations, nodeDegreeMap]);

  const focusGraphMeta = useMemo(() => {
    if (!selectedNodeId) {
      return null;
    }
    const relationIds = new Set<string>();
    const neighborNodeIds = new Set<string>([selectedNodeId]);
    for (const relation of displayRelations) {
      if (relation.source !== selectedNodeId && relation.target !== selectedNodeId) {
        continue;
      }
      relationIds.add(relation.relationId);
      neighborNodeIds.add(relation.source);
      neighborNodeIds.add(relation.target);
    }
    return {
      relationIds,
      neighborNodeIds
    };
  }, [displayRelations, selectedNodeId]);

  const graphArtifacts = useMemo(() => {
    const artifacts = artifactsQuery.data?.artifacts ?? [];
    return artifacts.filter((item) => item.kind === "knowledge_graph_3d" || item.kind === "knowledge_graph");
  }, [artifactsQuery.data?.artifacts]);

  const currentArtifactTitle =
    fallbackArtifactQuery.data?.artifact?.title
    ?? fallbackArtifact?.title
    ?? `${currentProject?.name ?? "当前项目"} 3D知识图谱`;

  const relationInsights = useMemo(() => {
    const focusNodeId = currentNode?.nodeId ?? null;
    if (!focusNodeId) {
      return {
        pairs: [] as NodeRelationPairGroup[],
        categoryTotals: [] as RelationCategoryTotal[],
        total: 0
      };
    }

    const relationPool = displayRelations.filter((item) => item.source === focusNodeId || item.target === focusNodeId);
    const pairMap = new Map<
      string,
      {
        targetNodeId: string;
        targetNodeLabel: string;
        directions: Set<"输入" | "输出">;
        typeGroupMap: Map<string, NodeRelationTypeGroup>;
      }
    >();
    const categoryTotalMap = new Map<string, RelationCategoryTotal>();

    for (const item of relationPool) {
      const directionLabel: "输入" | "输出" = item.source === focusNodeId ? "输出" : "输入";
      const targetNodeId = directionLabel === "输出" ? item.target : item.source;
      const targetNodeLabel = nodeLabelMap.get(targetNodeId) ?? targetNodeId;
      const relationType = normalizeRelationType(item.relationType);
      const category = classifyRelationType(relationType);
      const typeGroupKey = `${category.key}::${relationType}`;

      const existingCategoryTotal = categoryTotalMap.get(category.key);
      if (existingCategoryTotal) {
        existingCategoryTotal.count += 1;
      } else {
        categoryTotalMap.set(category.key, {
          key: category.key,
          label: category.label,
          order: category.order,
          count: 1
        });
      }

      const existingPair = pairMap.get(targetNodeId);
      if (!existingPair) {
        pairMap.set(targetNodeId, {
          targetNodeId,
          targetNodeLabel,
          directions: new Set([directionLabel]),
          typeGroupMap: new Map([
            [
              typeGroupKey,
              {
                key: typeGroupKey,
                categoryKey: category.key,
                categoryLabel: category.label,
                categoryOrder: category.order,
                relationType,
                rows: [
                  {
                    relationId: item.relationId,
                    relationType,
                    directionLabel,
                    sourceRef: item.sourceRef,
                    confirmedByUser: item.confirmedByUser
                  }
                ]
              }
            ]
          ])
        });
        continue;
      }

      existingPair.directions.add(directionLabel);
      const existingTypeGroup = existingPair.typeGroupMap.get(typeGroupKey);
      if (existingTypeGroup) {
        existingTypeGroup.rows.push({
          relationId: item.relationId,
          relationType,
          directionLabel,
          sourceRef: item.sourceRef,
          confirmedByUser: item.confirmedByUser
        });
      } else {
        existingPair.typeGroupMap.set(typeGroupKey, {
          key: typeGroupKey,
          categoryKey: category.key,
          categoryLabel: category.label,
          categoryOrder: category.order,
          relationType,
          rows: [
            {
              relationId: item.relationId,
              relationType,
              directionLabel,
              sourceRef: item.sourceRef,
              confirmedByUser: item.confirmedByUser
            }
          ]
        });
      }
    }

    const pairs = Array.from(pairMap.values())
      .map((group): NodeRelationPairGroup => {
        const typeGroups = Array.from(group.typeGroupMap.values())
          .sort((a, b) => {
            if (a.categoryOrder !== b.categoryOrder) {
              return a.categoryOrder - b.categoryOrder;
            }
            if (b.rows.length !== a.rows.length) {
              return b.rows.length - a.rows.length;
            }
            return a.relationType.localeCompare(b.relationType, "zh-Hans-CN");
          });
        const relationCount = typeGroups.reduce((total, typeGroup) => total + typeGroup.rows.length, 0);
        const hasInput = group.directions.has("输入");
        const hasOutput = group.directions.has("输出");
        const directionLabel: "输入" | "输出" | "双向" = hasInput && hasOutput ? "双向" : hasOutput ? "输出" : "输入";
        return {
          targetNodeId: group.targetNodeId,
          targetNodeLabel: group.targetNodeLabel,
          directionLabel,
          relationCount,
          typeGroups
        };
      })
      .sort((a, b) => {
        if (b.relationCount !== a.relationCount) {
          return b.relationCount - a.relationCount;
        }
        return a.targetNodeLabel.localeCompare(b.targetNodeLabel, "zh-Hans-CN");
      });

    const categoryTotals = Array.from(categoryTotalMap.values()).sort((a, b) => {
      if (a.order !== b.order) {
        return a.order - b.order;
      }
      return b.count - a.count;
    });

    return {
      pairs,
      categoryTotals,
      total: relationPool.length
    };
  }, [currentNode?.nodeId, displayRelations, nodeLabelMap]);

  const layoutMetrics = useMemo(() => {
    const totalWidth = Math.max(320, viewportWidth);
    const gap = totalWidth >= 1760 ? 18 : totalWidth >= 1400 ? 16 : 12;
    const showRightPanel = totalWidth >= 1180;
    const collapseChat = totalWidth < 920;
    const leftWidth = collapseChat ? 0 : totalWidth >= 1760 ? 336 : 300;
    const rightWidth = showRightPanel ? (totalWidth >= 1760 ? 356 : 320) : 0;

    return {
      gap,
      leftWidth,
      rightWidth,
      collapseChat,
      showRightPanel
    };
  }, [viewportWidth]);

  const canvasRegionStyle = useMemo<CSSProperties>(
    () => ({
      "--graph-panel-gap": `${layoutMetrics.gap}px`,
      "--graph-left-panel-width": `${layoutMetrics.leftWidth}px`,
      "--graph-right-panel-width": `${layoutMetrics.rightWidth}px`
    }) as CSSProperties,
    [layoutMetrics.gap, layoutMetrics.leftWidth, layoutMetrics.rightWidth]
  );

  useEffect(() => {
    if (!graphRef.current || displayNodes.length === 0) {
      return;
    }
    const fitPadding = layoutMetrics.showRightPanel ? 96 : 64;
    fitPaddingRef.current = fitPadding;
    engineFitPendingRef.current = true;
    let timerId = 0;
    const frameId = window.requestAnimationFrame(() => {
      timerId = window.setTimeout(() => {
        graphRef.current?.zoomToFit?.(700, fitPadding);
      }, 120);
    });
    return () => {
      window.cancelAnimationFrame(frameId);
      if (timerId) {
        window.clearTimeout(timerId);
      }
    };
  }, [displayNodes.length, displayRelations.length, size.width, size.height, fallbackArtifact?.artifactId, layoutMetrics.showRightPanel]);

  useEffect(() => {
    setChatDrawerOpen(!layoutMetrics.collapseChat);
  }, [layoutMetrics.collapseChat]);

  useEffect(() => {
    if (layoutMetrics.showRightPanel) {
      setRelationsDrawerOpen(false);
    }
  }, [layoutMetrics.showRightPanel]);

  useEffect(() => {
    graphRef.current?.refresh?.();
  }, [focusGraphMeta, selectedNodeId]);

  useEffect(() => {
    const body = chatBodyRef.current;
    if (!body) {
      return;
    }
    window.requestAnimationFrame(() => {
      body.scrollTo({
        top: body.scrollHeight,
        behavior: "auto"
      });
    });
  }, [chatMessages]);

  useEffect(() => {
    const element = chatInputRef.current;
    if (!element) {
      return;
    }
    element.style.height = "0px";
    const nextHeight = graphQuestion.trim().length === 0
      ? 32
      : Math.min(Math.max(element.scrollHeight, 32), 132);
    element.style.height = `${nextHeight}px`;
    element.style.overflowY = element.scrollHeight > 132 ? "auto" : "hidden";
  }, [graphQuestion]);

  if (!currentProject) {
    return <section className="workspace-generic-empty">先打开项目，再进入 3D 知识可视化工作台。</section>;
  }

  function handleSendGraphQuestion() {
    const question = graphQuestion.trim();
    if (!question || graphRagMutation.isPending) {
      return;
    }
    const requestId = buildRequestId();
    startTransition(() => {
      setChatMessages((current) => [
        ...current,
        {
          id: `user-${requestId}`,
          role: "user",
          content: question
        },
        {
          id: `assistant-${requestId}`,
          role: "assistant",
          content: "",
          isStreaming: true
        }
      ]);
    });
    graphRagMutation.mutate({ requestId, question });
  }

  return (
    <section className="workspace-single-surface graph-3d-workspace">
      <div className="graph-3d-stage">
        <div
          className={layoutMetrics.showRightPanel ? "graph-3d-canvas-region" : "graph-3d-canvas-region graph-3d-canvas-region-compact"}
          style={canvasRegionStyle}
          ref={canvasRegionRef}
        >
          {displayNodes.length > 0 ? (
            <>
              {layoutMetrics.collapseChat ? (
                <button
                  className={chatDrawerOpen ? "graph-3d-chat-toggle graph-3d-chat-toggle-active" : "graph-3d-chat-toggle"}
                  onClick={() => {
                    setChatDrawerOpen((current) => {
                      const nextOpen = !current;
                      if (nextOpen) {
                        setRelationsDrawerOpen(false);
                      }
                      return nextOpen;
                    });
                  }}
                >
                  {chatDrawerOpen ? "收起问答" : "打开问答"}
                </button>
              ) : null}

              {!layoutMetrics.showRightPanel ? (
                <button
                  className={
                    relationsDrawerOpen
                      ? "graph-3d-chat-toggle graph-3d-chat-toggle-right graph-3d-chat-toggle-active"
                      : "graph-3d-chat-toggle graph-3d-chat-toggle-right"
                  }
                  onClick={() => {
                    setRelationsDrawerOpen((current) => {
                      const nextOpen = !current;
                      if (nextOpen) {
                        setChatDrawerOpen(false);
                      }
                      return nextOpen;
                    });
                  }}
                >
                  {relationsDrawerOpen ? "收起关系" : "打开关系"}
                </button>
              ) : null}

              {(!layoutMetrics.collapseChat || chatDrawerOpen) ? (
              <aside className={layoutMetrics.collapseChat ? "graph-3d-overlay graph-3d-overlay-left graph-3d-overlay-left-drawer" : "graph-3d-overlay graph-3d-overlay-left"}>
                <div className="chat-pane graph-3d-chat-pane">
                  <div className="chat-pane-header chat-pane-header-compact">
                    <span>GraphRAG</span>
                  </div>
                  <div className="chat-pane-body" ref={chatBodyRef}>
                    <div className="chat-stream">
                    {chatMessages.length === 0 ? (
                      <div className="chat-message chat-message-system graph-3d-chat-empty">
                        输入问题开始查询。
                      </div>
                    ) : (
                      chatMessages.map((message) => (
                        <div
                          key={message.id}
                          className={
                            message.role === "assistant"
                              ? [
                                  "chat-message",
                                  "chat-message-assistant",
                                  "chat-message-card",
                                  message.isStreaming ? "chat-message-streaming" : ""
                                ].filter(Boolean).join(" ")
                              : "chat-message chat-message-user"
                          }
                        >
                          <div className="chat-message-head">
                            <div className="chat-message-role">{message.role === "assistant" ? "AI" : "你"}</div>
                          </div>
                          <div className={message.isStreaming ? "chat-message-content chat-message-content-streaming" : "chat-message-content"}>
                            {message.role === "assistant" ? (
                              message.isStreaming && !message.content.trim() ? (
                                <span className="chat-message-typing">正在输入…</span>
                              ) : (
                                <MarkdownArticle content={message.content} className="markdown-article-chat" />
                              )
                            ) : (
                              message.content
                            )}
                          </div>
                          {message.evidence && message.evidence.length > 0 ? (
                            <div className="graph-qa-evidence-row graph-3d-chat-evidence">
                              {message.evidence.slice(0, 3).map((item, index) => (
                                <button
                                  key={`${message.id}-${index}-${item.title}`}
                                  className="small-button graph-evidence-button"
                                  onClick={() => item.blockId && onJumpToBlock(item.blockId)}
                                >
                                  {item.sourceLabel}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))
                    )}
                    </div>
                  </div>

                  <div className="chat-input-shell chat-input-shell-flat graph-3d-chat-input-shell">
                    <textarea
                      ref={chatInputRef}
                      rows={1}
                      className="chat-input chat-input-flat graph-qa-input"
                      value={graphQuestion}
                      onChange={(event) => setGraphQuestion(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" || event.shiftKey) {
                          return;
                        }
                        event.preventDefault();
                        handleSendGraphQuestion();
                      }}
                      placeholder={currentNode ? `围绕“${currentNode.label}”继续提问` : "输入你想快速查询的知识问题"}
                    />
                    <div className="chat-input-footer chat-input-footer-compact">
                      <div className="chat-input-footer-spacer" />
                      <button
                        className="send-button"
                        disabled={!graphQuestion.trim() || graphRagMutation.isPending}
                        onClick={handleSendGraphQuestion}
                      >
                        {graphRagMutation.isPending ? "思考中" : "发送"}
                      </button>
                    </div>
                  </div>
                </div>
              </aside>
              ) : null}

              <div ref={hostRef} className="graph-3d-shell graph-3d-shell-stage">
                <ForceGraph3D
                  ref={graphRef}
                  graphData={graphData as any}
                  width={size.width}
                  height={size.height}
                  backgroundColor="#111318"
                  showNavInfo={false}
                  nodeOpacity={0.98}
                  linkOpacity={1}
                  nodeColor={(node: GraphViewportNode) => {
                    const degree = nodeDegreeMap.get(node.nodeId) ?? 1;
                    const baseStrength = Math.min(1, 0.58 + Math.min(degree, 10) * 0.04);
                    if (!focusGraphMeta) {
                      return `rgba(127, 183, 255, ${baseStrength})`;
                    }
                    if (node.nodeId === selectedNodeId) {
                      return "rgba(245, 247, 251, 1)";
                    }
                    if (focusGraphMeta.neighborNodeIds.has(node.nodeId)) {
                      return "rgba(152, 204, 255, 0.96)";
                    }
                    return "rgba(72, 93, 129, 0.52)";
                  }}
                  nodeVal={(node: GraphViewportNode) => {
                    const degree = nodeDegreeMap.get(node.nodeId) ?? 1;
                    const base = Math.max(4, Math.min(10.5, 4 + Math.max(node.weight, degree) * 0.85));
                    if (!focusGraphMeta) {
                      return base;
                    }
                    if (node.nodeId === selectedNodeId) {
                      return Math.min(16, base + 3.6);
                    }
                    if (focusGraphMeta.neighborNodeIds.has(node.nodeId)) {
                      return Math.min(12.4, base + 1.5);
                    }
                    return Math.max(2.6, base * 0.62);
                  }}
                  linkWidth={(link: GraphViewportLink) => {
                    if (!focusGraphMeta) {
                      return 1.2;
                    }
                    return focusGraphMeta.relationIds.has(link.relationId) ? 2.6 : 0.6;
                  }}
                  linkDirectionalParticles={focusGraphMeta ? 0 : 1}
                  linkDirectionalParticleWidth={2}
                  linkDirectionalParticleSpeed={0.004}
                  linkDirectionalParticleColor={(link: GraphViewportLink) => link.color}
                  nodeLabel={(node: GraphViewportNode) => `${node.label} · ${node.nodeType}`}
                  nodeThreeObjectExtend
                  nodeThreeObject={(node: GraphViewportNode) => buildNodeLabel(node, selectedNodeId, focusGraphMeta)}
                  linkColor={(link: GraphViewportLink) => {
                    if (!focusGraphMeta) {
                      return "rgba(81, 101, 132, 0.32)";
                    }
                    return focusGraphMeta.relationIds.has(link.relationId)
                      ? "rgba(173, 208, 255, 0.88)"
                      : "rgba(58, 74, 102, 0.16)";
                  }}
                  warmupTicks={80}
                  cooldownTicks={140}
                  d3AlphaDecay={0.024}
                  d3VelocityDecay={0.32}
                  onEngineStop={() => {
                    if (!engineFitPendingRef.current) {
                      return;
                    }
                    engineFitPendingRef.current = false;
                    graphRef.current?.zoomToFit?.(700, fitPaddingRef.current);
                  }}
                  onNodeClick={(node: GraphViewportNode) => {
                    setSelectedNodeId(node.nodeId);
                    const targetX = node.x ?? 0;
                    const targetY = node.y ?? 0;
                    const targetZ = node.z ?? 0;
                    const norm = Math.hypot(targetX, targetY, targetZ);
                    const distance = 240;
                    const nextPosition = norm > 0
                      ? {
                          x: targetX + (targetX / norm) * distance,
                          y: targetY + (targetY / norm) * distance,
                          z: targetZ + (targetZ / norm) * distance
                        }
                      : {
                          x: 0,
                          y: 0,
                          z: distance
                        };
                    graphRef.current?.cameraPosition?.(
                      nextPosition,
                      node,
                      900
                    );
                  }}
                  onBackgroundClick={() => setSelectedNodeId(null)}
                />
              </div>

              {layoutMetrics.showRightPanel || relationsDrawerOpen ? (
              <aside className={layoutMetrics.showRightPanel ? "graph-3d-overlay graph-3d-overlay-right" : "graph-3d-overlay graph-3d-overlay-right graph-3d-overlay-right-drawer"}>
                <div className="graph-3d-relations-panel">
                  <div className="graph-3d-relations-header">
                    <div className="graph-3d-relations-eyebrow">关系列表</div>
                    <div className="graph-3d-relations-title">{currentNode?.label ?? "未选择节点"}</div>
                    <div className="graph-3d-relations-meta">
                      {graphArtifacts.length > 1 ? (
                        <select
                          className="workspace-inline-select graph-3d-relations-select"
                          value={fallbackArtifact?.artifactId ?? ""}
                          onChange={(event) => onSelectArtifact?.(event.target.value)}
                        >
                          {graphArtifacts.map((item) => (
                            <option key={item.artifactId} value={item.artifactId}>
                              {item.title}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="graph-3d-relations-artifact">{currentArtifactTitle}</div>
                      )}
                      <div className="graph-3d-relations-metrics">
                        <div className="document-status-chip">{displayNodes.length} 个节点</div>
                        <div className="document-status-chip">{displayRelations.length} 条关系</div>
                      </div>
                    </div>
                    {currentNode?.sourceRef ? (
                      <button
                        className="small-button graph-3d-source-button"
                        onClick={() => onJumpToBlock(currentNode.sourceRef!)}
                      >
                        查看来源
                      </button>
                    ) : null}
                  </div>

                  <div className="graph-3d-relations-table-shell">
                    {relationInsights.pairs.length > 0 ? (
                      <>
                        <div className="graph-3d-relations-category-summary">
                          {relationInsights.categoryTotals.map((item) => (
                            <div key={item.key} className={`graph-3d-relations-category-chip graph-3d-relations-category-chip-${item.key}`}>
                              <span>{item.label}</span>
                              <strong>{item.count}</strong>
                            </div>
                          ))}
                        </div>

                        <div className="graph-3d-relations-group-list">
                          {relationInsights.pairs.map((pair) => (
                            <section key={pair.targetNodeId} className="graph-3d-relations-group-card">
                              <div className="graph-3d-relations-group-head">
                                <button
                                  className="graph-3d-node-link graph-3d-node-link-strong"
                                  onClick={() => setSelectedNodeId(pair.targetNodeId)}
                                >
                                  {pair.targetNodeLabel}
                                </button>
                                <div className="graph-3d-relations-group-meta">
                                  <span className="graph-3d-relations-group-direction">{pair.directionLabel}</span>
                                  <span>{pair.relationCount} 条</span>
                                </div>
                              </div>

                              <div className="graph-3d-relations-type-list">
                                {pair.typeGroups.map((typeGroup) => (
                                  <details key={typeGroup.key} className="graph-3d-relations-type-card" open={typeGroup.rows.length <= 2}>
                                    <summary className="graph-3d-relations-type-summary">
                                      <span className={`graph-3d-relations-type-category graph-3d-relations-type-category-${typeGroup.categoryKey}`}>
                                        {typeGroup.categoryLabel}
                                      </span>
                                      <span className="graph-3d-relations-type-name">{typeGroup.relationType}</span>
                                      <span className="graph-3d-relations-type-count">{typeGroup.rows.length} 条</span>
                                    </summary>
                                    <div className="graph-3d-relations-item-list">
                                      {typeGroup.rows.map((row) => (
                                        <div key={row.relationId} className="graph-3d-relations-item-row">
                                          <span className="graph-3d-relations-item-direction">{row.directionLabel}</span>
                                          <span className="graph-3d-relations-item-status">{row.confirmedByUser ? "已确认" : "待确认"}</span>
                                          {row.sourceRef ? (
                                            <button
                                              className="graph-3d-table-action"
                                              onClick={() => onJumpToBlock(row.sourceRef!)}
                                            >
                                              查看来源
                                            </button>
                                          ) : (
                                            <span className="graph-3d-table-muted">无来源</span>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  </details>
                                ))}
                              </div>
                            </section>
                          ))}
                        </div>
                      </>
                    ) : (
                      <div className="graph-3d-relation-empty">当前节点暂无可展示关系。</div>
                    )}
                  </div>
                </div>
              </aside>
              ) : null}

            </>
          ) : (
            <div className="workspace-generic-empty">当前项目还没有可用的 3D 图谱数据。</div>
          )}
        </div>
      </div>
    </section>
  );
}

function buildNodeLabel(
  node: GraphViewportNode,
  selectedNodeId: string | null,
  focusGraphMeta: {
    relationIds: Set<string>;
    neighborNodeIds: Set<string>;
  } | null
) {
  const label = new SpriteText(node.label);
  if (!focusGraphMeta) {
    label.color = "#d8e9ff";
    label.textHeight = 7.2;
    label.position.set(0, 9.8, 0);
    return label;
  }
  if (node.nodeId === selectedNodeId) {
    label.color = "#f7fbff";
    label.textHeight = 8.6;
    label.position.set(0, 12.2, 0);
    return label;
  }
  if (focusGraphMeta.neighborNodeIds.has(node.nodeId)) {
    label.color = "#d9ebff";
    label.textHeight = 7.2;
    label.position.set(0, 10.6, 0);
    return label;
  }
  label.color = "#7285a9";
  label.textHeight = 6.2;
  label.position.set(0, 9.4, 0);
  return label;
}

function parseStudioGraphPreview(previewJson: string | null) {
  if (!previewJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(previewJson) as {
      graph?: StudioPreviewGraph;
    };
    if (!parsed.graph?.nodes?.length) {
      return null;
    }
    return {
      nodes: parsed.graph.nodes
        .filter((item) => Boolean(item?.id) && Boolean(item?.label))
        .map((item) => ({
          id: item.id,
          label: item.label,
          weight: Number.isFinite(item.weight) ? item.weight : 1
        })),
      links: (parsed.graph.links ?? [])
        .filter((item) => Boolean(item?.source) && Boolean(item?.target))
        .map((item) => ({
          source: item.source,
          target: item.target
        }))
    };
  } catch {
    return null;
  }
}

function buildRequestId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRelationType(value: string) {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : "关联";
}

function classifyRelationType(value: string) {
  const lowered = value.toLowerCase();

  if (/(因果|导致|引发|影响|依赖|先于|后于|before|after|cause|effect|depend|trigger|flow)/i.test(value) || /(cause|effect|depend|trigger|before|after|flow)/i.test(lowered)) {
    return { key: "causal", label: "因果/时序", order: 1 };
  }
  if (/(组成|包含|隶属|层级|上下位|父子|章节|结构|部分|part|contain|belongs|parent|child|hierarchy)/i.test(value) || /(part|contain|belongs|parent|child|hierarchy)/i.test(lowered)) {
    return { key: "structural", label: "结构关系", order: 2 };
  }
  if (/(证据|引用|出处|来源|证明|支持|实验|文献|source|cite|evidence|support|prove|reference)/i.test(value) || /(source|cite|evidence|support|prove|reference)/i.test(lowered)) {
    return { key: "evidence", label: "证据关系", order: 3 };
  }
  if (/(同义|近义|相关|语义|映射|对应|话题|概念|is_a|related|similar|semantic|mapping|topic|concept)/i.test(value) || /(related|similar|semantic|mapping|topic|concept|is_a)/i.test(lowered)) {
    return { key: "semantic", label: "语义关系", order: 4 };
  }
  return { key: "other", label: "其他关系", order: 5 };
}
