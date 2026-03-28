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
  queryGraphSource,
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
    relationType?: string;
    confidence?: number;
  }>;
}

interface RelationNarrativeRow {
  relationId: string;
  relationType: string;
  categoryKey: string;
  categoryLabel: string;
  directionLabel: "输入" | "输出";
  peerNodeId: string;
  peerNodeLabel: string;
  question: string;
  statement: string;
  sourceRef: string | null;
  confirmedByUser: boolean;
}

interface RelationNarrativeGroup {
  key: string;
  label: string;
  order: number;
  relationType: string;
  rows: RelationNarrativeRow[];
}

interface NodeSourceSnippet {
  documentId?: string;
  title: string;
  snippet: string;
  jumpTarget?: string;
  score: number;
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
  const chatBodyRef = useRef<HTMLDivElement | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [size, setSize] = useState({ width: 1200, height: 720 });
  const [viewportWidth, setViewportWidth] = useState(1440);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [graphQuestion, setGraphQuestion] = useState("");
  const [chatMessages, setChatMessages] = useState<GraphChatMessage[]>([]);
  const [chatDrawerOpen, setChatDrawerOpen] = useState(false);
  const [relationsDrawerOpen, setRelationsDrawerOpen] = useState(false);
  const [relationsPanelExpanded, setRelationsPanelExpanded] = useState(false);

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

  const liveDisplayNodes = useMemo<GraphViewportNode[]>(
    () =>
      liveNodes.map((node) => ({
        id: node.nodeId,
        nodeId: node.nodeId,
        label: node.label,
        nodeType: node.nodeType,
        sourceRef: node.sourceRef,
        weight: 1
      })),
    [liveNodes]
  );

  const liveDisplayRelations = useMemo<GraphViewportLink[]>(
    () =>
      liveRelations.map((relation) => ({
        relationId: relation.relationId,
        source: relation.fromNodeId,
        target: relation.toNodeId,
        relationType: relation.relationType,
        color: "#516584",
        confirmedByUser: relation.confirmedByUser,
        sourceRef: relation.sourceRef
      })),
    [liveRelations]
  );

  const scopedLiveGraph = useMemo(() => {
    if (!hasLiveGraph) {
      return { nodes: [] as GraphViewportNode[], relations: [] as GraphViewportLink[] };
    }

    const artifactId = fallbackArtifact?.artifactId ?? selectedArtifactId ?? null;
    let relations = liveDisplayRelations;
    if (artifactId) {
      const scoped = relations.filter((item) => item.sourceRef === artifactId);
      if (scoped.length > 0) {
        relations = scoped;
      }
    }

    const connectedNodeIds = new Set<string>();
    for (const relation of relations) {
      connectedNodeIds.add(relation.source);
      connectedNodeIds.add(relation.target);
    }

    let nodes = liveDisplayNodes.filter((item) => connectedNodeIds.has(item.nodeId));
    if (nodes.length === 0 || relations.length === 0) {
      return {
        nodes: liveDisplayNodes,
        relations: liveDisplayRelations
      };
    }

    const largestComponentNodeIds = pickLargestConnectedNodeIds(
      nodes.map((item) => item.nodeId),
      relations
    );
    if (largestComponentNodeIds.size >= 4) {
      nodes = nodes.filter((item) => largestComponentNodeIds.has(item.nodeId));
      relations = relations.filter(
        (item) => largestComponentNodeIds.has(item.source) && largestComponentNodeIds.has(item.target)
      );
    }

    return { nodes, relations };
  }, [fallbackArtifact?.artifactId, hasLiveGraph, liveDisplayNodes, liveDisplayRelations, selectedArtifactId]);

  const displayNodes = useMemo<GraphViewportNode[]>(() => {
    if (hasLiveGraph) {
      return scopedLiveGraph.nodes;
    }
    return (fallbackPreview?.nodes ?? []).map((node) => ({
      id: node.id,
      nodeId: node.id,
      label: node.label,
      nodeType: "概念",
      sourceRef: null,
      weight: node.weight
    }));
  }, [fallbackPreview?.nodes, hasLiveGraph, scopedLiveGraph.nodes]);

  const displayRelations = useMemo<GraphViewportLink[]>(() => {
    if (hasLiveGraph) {
      return scopedLiveGraph.relations;
    }
    return (fallbackPreview?.links ?? []).map((relation, index) => ({
      relationId: `preview-${relation.source}-${relation.target}-${index}`,
      source: relation.source,
      target: relation.target,
      relationType: normalizeRelationType(relation.relationType ?? "关联"),
      color: "#516584",
      confirmedByUser: true,
      sourceRef: null
    }));
  }, [fallbackPreview?.links, hasLiveGraph, scopedLiveGraph.relations]);

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
    const region = canvasRegionRef.current;
    if (!region) {
      return;
    }

    let frameId = 0;
    let settleId = 0;

    const syncSize = () => {
      const rect = region.getBoundingClientRect();
      const nextWidth = Math.max(320, Math.floor(rect.width));
      const nextHeight = Math.max(280, Math.floor(rect.height));
      setSize((current) =>
        current.width === nextWidth && current.height === nextHeight
          ? current
          : {
              width: nextWidth,
              height: nextHeight
            }
      );
    };

    const settleMeasure = () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      if (settleId) {
        window.clearTimeout(settleId);
      }
      syncSize();
      frameId = window.requestAnimationFrame(() => {
        syncSize();
        settleId = window.setTimeout(syncSize, 140);
      });
    };

    syncSize();
    settleMeasure();
    const observer = new ResizeObserver(settleMeasure);
    observer.observe(region);
    window.addEventListener("resize", settleMeasure);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", settleMeasure);
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      if (settleId) {
        window.clearTimeout(settleId);
      }
    };
  }, [viewportWidth, relationsDrawerOpen, chatDrawerOpen]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) {
      return;
    }
    graph.width?.(size.width);
    graph.height?.(size.height);
    graph.refresh?.();
  }, [size.height, size.width]);

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
    const focusNodeLabel = currentNode?.label ?? "当前节点";
    if (!focusNodeId) {
      return {
        groups: [] as RelationNarrativeGroup[],
        prerequisiteSummary: "",
        total: 0
      };
    }

    const relationPool = displayRelations.filter((item) => item.source === focusNodeId || item.target === focusNodeId);
    const groupMap = new Map<string, RelationNarrativeGroup>();
    const prerequisiteNodes = new Set<string>();

    for (const item of relationPool) {
      const directionLabel: "输入" | "输出" = item.source === focusNodeId ? "输出" : "输入";
      const peerNodeId = directionLabel === "输出" ? item.target : item.source;
      const peerNodeLabel = nodeLabelMap.get(peerNodeId) ?? peerNodeId;
      const relationType = sanitizeRelationTypeForPair(
        focusNodeLabel,
        peerNodeLabel,
        normalizeRelationType(item.relationType)
      );
      const relationCategory = classifyRelationType(relationType);
      const groupKey = relationCategory.key;
      const existingGroup = groupMap.get(groupKey);
      const row: RelationNarrativeRow = {
        relationId: item.relationId,
        relationType: relationCategory.canonicalType,
        categoryKey: relationCategory.key,
        categoryLabel: relationCategory.label,
        directionLabel,
        peerNodeId,
        peerNodeLabel,
        question: buildRelationQuestion({
          focusNodeLabel,
          peerNodeLabel,
          directionLabel,
          relationType: relationCategory.canonicalType
        }),
        statement: buildRelationStatement({
          focusNodeLabel,
          peerNodeLabel,
          directionLabel,
          relationType: relationCategory.canonicalType
        }),
        sourceRef: item.sourceRef,
        confirmedByUser: item.confirmedByUser
      };

      if (relationCategory.canonicalType === "前置依赖" && directionLabel === "输入") {
        prerequisiteNodes.add(peerNodeLabel);
      }

      if (existingGroup) {
        existingGroup.rows.push(row);
      } else {
        groupMap.set(groupKey, {
          key: groupKey,
          label: relationCategory.label,
          order: relationCategory.order,
          relationType: relationCategory.canonicalType,
          rows: [row]
        });
      }
    }

    const groups = Array.from(groupMap.values())
      .map((group) => ({
        ...group,
        rows: [...group.rows].sort((left, right) => {
          if (left.peerNodeLabel !== right.peerNodeLabel) {
            return left.peerNodeLabel.localeCompare(right.peerNodeLabel, "zh-Hans-CN");
          }
          if (left.directionLabel !== right.directionLabel) {
            return left.directionLabel.localeCompare(right.directionLabel, "zh-Hans-CN");
          }
          return left.relationId.localeCompare(right.relationId, "zh-Hans-CN");
        })
      }))
      .sort((a, b) => {
        if (a.order !== b.order) {
          return a.order - b.order;
        }
        if (b.rows.length !== a.rows.length) {
          return b.rows.length - a.rows.length;
        }
        return a.label.localeCompare(b.label, "zh-Hans-CN");
      });

    const prerequisiteSummary = prerequisiteNodes.size > 0
      ? `前置知识：${Array.from(prerequisiteNodes).sort((a, b) => a.localeCompare(b, "zh-Hans-CN")).join("、")}`
      : "";

    return {
      groups,
      prerequisiteSummary,
      total: relationPool.length
    };
  }, [currentNode?.label, currentNode?.nodeId, displayRelations, nodeLabelMap]);

  const relationSummaryChips = useMemo(
    () =>
      relationInsights.groups.map((group) => ({
        key: group.key,
        label: group.label,
        count: group.rows.length
      })),
    [relationInsights.groups]
  );

  const nodeSourceQuery = useQuery({
    queryKey: [
      "graph-3d-node-source",
      currentProject?.projectId,
      fallbackArtifact?.artifactId,
      currentNode?.nodeId,
      currentNode?.label
    ],
    enabled: Boolean(currentProject?.projectId && currentNode?.label),
    queryFn: async (): Promise<NodeSourceSnippet[]> => {
      const keyword = (currentNode?.label ?? "").trim();
      if (!keyword) {
        return [];
      }
      const sourceResult = await queryGraphSource({
        projectId: currentProject!.projectId,
        artifactId: fallbackArtifact?.artifactId ?? selectedArtifactId ?? undefined,
        keyword,
        limit: 6
      });
      if (sourceResult.snippets.length > 0) {
        return sourceResult.snippets.map((item) => ({
          documentId: item.documentId,
          title: item.title,
          snippet: item.snippet,
          score: item.score
        }));
      }

      const rag = await graphRagQuery({
        projectId: currentProject!.projectId,
        query: `请给出与「${keyword}」直接相关的原文片段`,
        focusNodeId: currentNode?.nodeId ?? undefined,
        history: []
      });
      const dedup = new Set<string>();
      const fallback = [] as NodeSourceSnippet[];
      for (const evidence of rag.evidence) {
        const key = `${evidence.title}-${evidence.snippet}`.trim();
        if (!key || dedup.has(key)) {
          continue;
        }
        dedup.add(key);
        fallback.push({
          title: evidence.title || "图谱证据",
          snippet: evidence.snippet,
          jumpTarget: evidence.blockId ?? undefined,
          score: 0.1
        });
        if (fallback.length >= 4) {
          break;
        }
      }
      return fallback;
    }
  });

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
      return;
    }
    setRelationsPanelExpanded(false);
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

              {layoutMetrics.showRightPanel && !relationsPanelExpanded ? (
                <button
                  className="graph-3d-chat-toggle graph-3d-chat-toggle-right graph-3d-relations-collapsed-toggle"
                  onClick={() => setRelationsPanelExpanded(true)}
                >
                  打开关系
                </button>
              ) : null}

              {layoutMetrics.showRightPanel && !relationsPanelExpanded ? (
                <aside className="graph-3d-overlay graph-3d-overlay-source-inline">
                  <div className="graph-3d-source-preview-panel">
                    <div className="graph-3d-source-preview-head">
                      <div className="graph-3d-source-preview-eyebrow">原文预览</div>
                      <div className="graph-3d-source-preview-title">{currentNode?.label ?? "未选择节点"}</div>
                    </div>
                    <div className="graph-3d-source-preview-body">
                      {nodeSourceQuery.isFetching ? (
                        <div className="graph-3d-source-preview-empty">正在加载原文片段…</div>
                      ) : nodeSourceQuery.data && nodeSourceQuery.data.length > 0 ? (
                        <div className="graph-3d-source-preview-list">
                          {nodeSourceQuery.data.map((row) => (
                            <article key={`${row.title}-${row.snippet.slice(0, 36)}`} className="graph-3d-source-preview-item">
                              <div className="graph-3d-source-preview-item-title">{row.title || "原文片段"}</div>
                              <div className="graph-3d-source-preview-item-snippet">{row.snippet}</div>
                              {row.jumpTarget ? (
                                <button
                                  className="graph-3d-table-action"
                                  onClick={() => onJumpToBlock(row.jumpTarget!)}
                                >
                                  打开原文位置
                                </button>
                              ) : null}
                            </article>
                          ))}
                        </div>
                      ) : (
                        <div className="graph-3d-source-preview-empty">当前节点暂无可展示的原文片段。</div>
                      )}
                    </div>
                  </div>
                </aside>
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

              <div className="graph-3d-shell graph-3d-shell-stage">
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
                      return 1.8;
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
                      return "rgba(143, 189, 255, 0.68)";
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

              {(layoutMetrics.showRightPanel ? relationsPanelExpanded : relationsDrawerOpen) ? (
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
                    {layoutMetrics.showRightPanel ? (
                      <button
                        className="small-button graph-3d-relations-collapse-button"
                        onClick={() => setRelationsPanelExpanded(false)}
                      >
                        收起关系
                      </button>
                    ) : null}
                  </div>

                  <div className="graph-3d-relations-table-shell">
                    {relationInsights.groups.length > 0 ? (
                      <>
                        <div className="graph-3d-relations-category-summary graph-3d-relations-category-summary-natural">
                          {relationSummaryChips.map((item) => (
                            <div key={item.key} className="graph-3d-relations-category-chip graph-3d-relations-category-chip-natural">
                              <span>{item.label}</span>
                              <strong>{item.count} 条</strong>
                            </div>
                          ))}
                        </div>

                        {relationInsights.prerequisiteSummary ? (
                          <div className="graph-3d-prerequisite-summary">
                            {relationInsights.prerequisiteSummary}
                          </div>
                        ) : null}

                        <div className="graph-3d-relations-group-list">
                          {relationInsights.groups.map((group, groupIndex) => (
                            <details
                              key={group.key}
                              className="graph-3d-relations-type-card graph-3d-relations-type-card-natural"
                              open={groupIndex === 0}
                            >
                              <summary className="graph-3d-relations-type-summary graph-3d-relations-type-summary-natural">
                                <span className="graph-3d-relations-type-name">{group.label}</span>
                                <span className="graph-3d-relations-type-count">{group.rows.length} 条</span>
                              </summary>
                              <div className="graph-3d-relations-natural-list">
                                {group.rows.map((row) => (
                                  <article key={row.relationId} className="graph-3d-relations-natural-item">
                                    <div className="graph-3d-relations-natural-question">{row.question}</div>
                                    <div className="graph-3d-relations-natural-answer">{row.statement}</div>
                                    <div className="graph-3d-relations-natural-meta">
                                      <span className="graph-3d-relations-item-direction">{row.directionLabel}</span>
                                      <span className="graph-3d-relations-item-status">{row.confirmedByUser ? "已确认" : "待确认"}</span>
                                      <button
                                        className="graph-3d-table-action"
                                        onClick={() => setSelectedNodeId(row.peerNodeId)}
                                      >
                                        定位节点
                                      </button>
                                      <span className="graph-3d-table-muted">来源：图谱生成链路</span>
                                    </div>
                                  </article>
                                ))}
                              </div>
                            </details>
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
          target: item.target,
          relationType: item.relationType
        }))
    };
  } catch {
    return null;
  }
}

function pickLargestConnectedNodeIds(nodeIds: string[], relations: GraphViewportLink[]) {
  const adjacency = new Map<string, string[]>();
  for (const nodeId of nodeIds) {
    adjacency.set(nodeId, []);
  }
  for (const relation of relations) {
    if (!adjacency.has(relation.source) || !adjacency.has(relation.target)) {
      continue;
    }
    adjacency.get(relation.source)!.push(relation.target);
    adjacency.get(relation.target)!.push(relation.source);
  }

  const visited = new Set<string>();
  let largest = new Set<string>();

  for (const nodeId of nodeIds) {
    if (visited.has(nodeId)) {
      continue;
    }
    const stack = [nodeId];
    const component = new Set<string>();
    visited.add(nodeId);
    while (stack.length > 0) {
      const current = stack.pop()!;
      component.add(current);
      for (const next of adjacency.get(current) ?? []) {
        if (visited.has(next)) {
          continue;
        }
        visited.add(next);
        stack.push(next);
      }
    }
    if (component.size > largest.size) {
      largest = component;
    }
  }

  return largest;
}

function buildRequestId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRelationType(value: string) {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : "关联";
}

function sanitizeRelationTypeForPair(leftLabel: string, rightLabel: string, relationType: string) {
  const normalized = normalizeRelationType(relationType);
  if (normalized !== "实现/调用") {
    return normalized;
  }
  if (isCallableLabel(leftLabel) && isCallableLabel(rightLabel)) {
    return normalized;
  }
  if (isConstraintLabel(leftLabel) || isConstraintLabel(rightLabel)) {
    return "约束/边界";
  }
  if (isConfusionLabel(leftLabel) || isConfusionLabel(rightLabel)) {
    return "易混淆";
  }
  if (isPrerequisiteLabel(leftLabel) || isPrerequisiteLabel(rightLabel)) {
    return "前置依赖";
  }
  if (isClassMechanismLabel(leftLabel) || isClassMechanismLabel(rightLabel)) {
    return "包含";
  }
  return "相关主题";
}

function classifyRelationType(value: string) {
  const normalized = normalizeRelationType(value);
  if (/(前置|依赖|先于|准备|基础)/.test(normalized)) {
    return { key: "prerequisite", label: "前置知识关系", order: 1, canonicalType: "前置依赖" };
  }
  if (/(包含|组成|隶属|层级|父子|章节|结构|部分)/.test(normalized)) {
    return { key: "containment", label: "结构组成关系", order: 2, canonicalType: "包含" };
  }
  if (/(并列|对比|区别|差异)/.test(normalized)) {
    return { key: "comparison", label: "并列对比关系", order: 3, canonicalType: "并列对比" };
  }
  if (/(实现|调用|机制|接口)/.test(normalized)) {
    return { key: "implementation", label: "实现调用关系", order: 4, canonicalType: "实现/调用" };
  }
  if (/(输入|输出|参数|返回|数据流)/.test(normalized)) {
    return { key: "io", label: "输入输出关系", order: 5, canonicalType: "输入输出" };
  }
  if (/(混淆|误区|易错)/.test(normalized)) {
    return { key: "confusion", label: "易混淆关系", order: 6, canonicalType: "易混淆" };
  }
  if (/(应用|场景|实战|工程)/.test(normalized)) {
    return { key: "application", label: "应用场景关系", order: 7, canonicalType: "应用场景" };
  }
  if (/(约束|边界|限制|风险)/.test(normalized)) {
    return { key: "constraint", label: "约束边界关系", order: 8, canonicalType: "约束/边界" };
  }
  if (/(示例|例子|样例|案例)/.test(normalized)) {
    return { key: "example", label: "示例关系", order: 9, canonicalType: "示例" };
  }
  if (/(相关|关联)/.test(normalized)) {
    return { key: "topic", label: "相关主题关系", order: 10, canonicalType: "相关主题" };
  }
  return {
    key: `other-${normalized}`,
    label: `${normalized}关系`,
    order: 99,
    canonicalType: normalized
  };
}

function buildRelationQuestion(input: {
  focusNodeLabel: string;
  peerNodeLabel: string;
  relationType: string;
  directionLabel: "输入" | "输出";
}) {
  const { focusNodeLabel, peerNodeLabel, relationType, directionLabel } = input;
  if (relationType === "前置依赖") {
    return directionLabel === "输入"
      ? `「${focusNodeLabel}」的前置知识是什么？`
      : `「${peerNodeLabel}」的前置知识是什么？`;
  }
  if (relationType === "并列对比") {
    return `「${focusNodeLabel}」和「${peerNodeLabel}」的区别是什么？`;
  }
  if (relationType === "易混淆") {
    return `「${focusNodeLabel}」和「${peerNodeLabel}」容易混淆在哪里？`;
  }
  return `「${focusNodeLabel}」和「${peerNodeLabel}」是什么关系？`;
}

function buildRelationStatement(input: {
  focusNodeLabel: string;
  peerNodeLabel: string;
  relationType: string;
  directionLabel: "输入" | "输出";
}) {
  const { focusNodeLabel, peerNodeLabel, relationType, directionLabel } = input;
  if (relationType === "前置依赖") {
    return directionLabel === "输入"
      ? `结论：学习「${focusNodeLabel}」前，建议先掌握「${peerNodeLabel}」。`
      : `结论：学习「${peerNodeLabel}」前，建议先掌握「${focusNodeLabel}」。`;
  }
  if (relationType === "包含") {
    return `结论：「${focusNodeLabel}」与「${peerNodeLabel}」存在包含关系，表示二者处于同一结构层级。`;
  }
  if (relationType === "并列对比") {
    return `结论：「${focusNodeLabel}」与「${peerNodeLabel}」是并列概念，适合放在一起对比理解。`;
  }
  if (relationType === "实现/调用") {
    return `结论：「${focusNodeLabel}」与「${peerNodeLabel}」存在实现/调用关系，通常发生在函数、方法或接口层面。`;
  }
  if (relationType === "输入输出") {
    return directionLabel === "输入"
      ? `结论：「${peerNodeLabel}」的输出会流向「${focusNodeLabel}」。`
      : `结论：「${focusNodeLabel}」的输出会流向「${peerNodeLabel}」。`;
  }
  if (relationType === "易混淆") {
    return `结论：「${focusNodeLabel}」与「${peerNodeLabel}」容易混淆，建议重点区分定义、边界和典型用法。`;
  }
  if (relationType === "应用场景") {
    return `结论：「${focusNodeLabel}」与「${peerNodeLabel}」存在应用场景关联，可在同一类任务中联合使用。`;
  }
  if (relationType === "约束/边界") {
    return directionLabel === "输入"
      ? `结论：「${peerNodeLabel}」对「${focusNodeLabel}」形成约束边界。`
      : `结论：「${focusNodeLabel}」对「${peerNodeLabel}」形成约束边界。`;
  }
  if (relationType === "示例") {
    return `结论：「${focusNodeLabel}」与「${peerNodeLabel}」构成示例关系，可通过实例加深理解。`;
  }
  if (relationType === "相关主题") {
    return `结论：「${focusNodeLabel}」与「${peerNodeLabel}」属于相关主题，建议结合上下文对照学习。`;
  }
  return `结论：「${focusNodeLabel}」与「${peerNodeLabel}」存在「${relationType}」关系。`;
}

function containsAny(text: string, keywords: string[]) {
  const value = text.toLowerCase();
  return keywords.some((keyword) => value.includes(keyword));
}

function isCallableLabel(value: string) {
  return containsAny(value, ["函数", "方法", "接口", "api", "调用", "回调", "operator", "操作符"]);
}

function isClassMechanismLabel(value: string) {
  return containsAny(value, ["类机制", "对象模型", "模板机制", "面向对象", "类"]);
}

function isConstraintLabel(value: string) {
  return containsAny(value, ["不能", "不可", "限制", "约束", "边界", "风险", "破坏"]);
}

function isConfusionLabel(value: string) {
  return containsAny(value, ["混淆", "误区", "易错", "易混"]);
}

function isPrerequisiteLabel(value: string) {
  return containsAny(value, ["前置", "基础", "准备", "先学", "依赖"]);
}
