import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type Simulation } from "d3-force";
import type { Project, StudioArtifact } from "@knowledgeos/shared-types";
import { getStudioArtifact, listStudioArtifacts } from "../lib/commands/client";

interface KnowledgeGraphWorkspaceProps {
  currentProject: Project | null;
  selectedArtifactId: string | null;
  onSelectArtifact: (artifactId: string) => void;
}

interface GraphNodeRecord {
  id: string;
  label: string;
  weight: number;
}

interface GraphLinkRecord {
  source: string;
  target: string;
}

interface GraphPreviewPayload {
  graph?: {
    nodes: GraphNodeRecord[];
    links: GraphLinkRecord[];
  };
  excerpt?: string;
  lineCount?: number;
}

interface GraphSimulationNode extends SimulationNodeDatum, GraphNodeRecord {
  x: number;
  y: number;
}

interface GraphSimulationLink extends SimulationLinkDatum<GraphSimulationNode> {
  source: string | GraphSimulationNode;
  target: string | GraphSimulationNode;
}

interface GraphDragState {
  nodeId: string;
  pointerId: number;
  offsetX: number;
  offsetY: number;
}

interface GraphViewportState {
  scale: number;
  offsetX: number;
  offsetY: number;
}

interface GraphPanState {
  pointerId: number;
  startX: number;
  startY: number;
  originOffsetX: number;
  originOffsetY: number;
}

export function KnowledgeGraphWorkspace({
  currentProject,
  selectedArtifactId,
  onSelectArtifact
}: KnowledgeGraphWorkspaceProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  const artifactsQuery = useQuery({
    queryKey: ["knowledge-graph-artifacts", currentProject?.projectId],
    queryFn: async () => listStudioArtifacts({ projectId: currentProject!.projectId }),
    enabled: Boolean(currentProject?.projectId)
  });

  const graphArtifacts = useMemo(
    () => (artifactsQuery.data?.artifacts ?? []).filter((artifact) => artifact.kind === "knowledge_graph"),
    [artifactsQuery.data?.artifacts]
  );

  useEffect(() => {
    if (!selectedArtifactId && graphArtifacts.length > 0) {
      onSelectArtifact(graphArtifacts[0].artifactId);
    }
  }, [graphArtifacts, onSelectArtifact, selectedArtifactId]);

  const selectedArtifact = graphArtifacts.find((artifact) => artifact.artifactId === selectedArtifactId) ?? graphArtifacts[0] ?? null;

  const selectedArtifactQuery = useQuery({
    queryKey: ["knowledge-graph-artifact", selectedArtifact?.artifactId],
    queryFn: async () => getStudioArtifact(selectedArtifact!.artifactId),
    enabled: Boolean(selectedArtifact?.artifactId)
  });

  const artifact = selectedArtifactQuery.data?.artifact ?? selectedArtifact;
  const preview = useMemo(() => parseGraphPreview(artifact), [artifact]);
  const graph = preview?.graph ?? null;
  const currentNode = useMemo(
    () => graph?.nodes.find((node) => node.id === selectedNodeId) ?? graph?.nodes[0] ?? null,
    [graph?.nodes, selectedNodeId]
  );

  useEffect(() => {
    if (currentNode && currentNode.id !== selectedNodeId) {
      setSelectedNodeId(currentNode.id);
    }
  }, [currentNode, selectedNodeId]);

  if (!currentProject) {
    return <section className="workspace-generic-empty">先打开项目，再进入知识网络工作台。</section>;
  }

  return (
    <section className="workspace-grid knowledge-graph-workspace-grid">
      <aside className="workspace-sidepanel">
        <div className="workspace-panel-title">知识网络结果</div>
        <div className="workspace-list">
          {graphArtifacts.map((item) => (
            <button
              key={item.artifactId}
              className={item.artifactId === artifact?.artifactId ? "workspace-list-row workspace-list-row-active" : "workspace-list-row"}
              onClick={() => onSelectArtifact(item.artifactId)}
            >
              <strong>{item.title}</strong>
              <span>{item.currentStage ?? "等待查看"}</span>
            </button>
          ))}
          {graphArtifacts.length === 0 ? <div className="workspace-generic-empty">当前还没有生成知识网络。</div> : null}
        </div>
      </aside>

      <section className="workspace-editor knowledge-graph-editor">
        <div className="editor-header">
          <div>
            <div className="workspace-panel-title">Knowledge Graph</div>
            <h2>{artifact?.title ?? "知识网络工作台"}</h2>
          </div>
          {graph ? (
            <div className="document-status-chip">
              {graph.nodes.length} 个节点 · {graph.links.length} 条连接
            </div>
          ) : null}
        </div>
        {graph ? (
          <KnowledgeGraphCanvas
            graph={graph}
            selectedNodeId={selectedNodeId}
            hoveredNodeId={hoveredNodeId}
            onSelectNode={setSelectedNodeId}
            onHoverNode={setHoveredNodeId}
          />
        ) : (
          <div className="workspace-generic-empty">当前产物还没有可用的网络预览。</div>
        )}
      </section>

      <aside className="workspace-preview">
        <div className="workspace-panel-title">节点详情</div>
        {currentNode ? (
          <div className="detail-card">
            <strong>{currentNode.label}</strong>
            <span>连接权重：{currentNode.weight}</span>
            <span>网络节点 ID：{currentNode.id}</span>
          </div>
        ) : (
          <div className="workspace-generic-empty">点击节点后，这里会显示详情。</div>
        )}
      </aside>
    </section>
  );
}

function KnowledgeGraphCanvas({
  graph,
  selectedNodeId,
  hoveredNodeId,
  onSelectNode,
  onHoverNode
}: {
  graph: NonNullable<GraphPreviewPayload["graph"]>;
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  onHoverNode: (nodeId: string | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const simulationRef = useRef<Simulation<GraphSimulationNode, GraphSimulationLink> | null>(null);
  const nodesRef = useRef<GraphSimulationNode[]>([]);
  const [size, setSize] = useState({ width: 900, height: 620 });
  const [dragState, setDragState] = useState<GraphDragState | null>(null);
  const [panState, setPanState] = useState<GraphPanState | null>(null);
  const [viewport, setViewport] = useState<GraphViewportState>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [layout, setLayout] = useState(() => ({
    nodes: graph.nodes.map((node, index): GraphSimulationNode => ({
      ...node,
      x: 90 + (index % 5) * 120,
      y: 90 + Math.floor(index / 5) * 80
    })),
    links: graph.links as GraphSimulationLink[]
  }));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const syncSize = () => {
      setSize({
        width: Math.max(680, Math.floor(host.clientWidth)),
        height: Math.max(520, Math.floor(host.clientHeight))
      });
    };
    syncSize();
    const observer = new ResizeObserver(syncSize);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setDragState(null);
    const simulationNodes: GraphSimulationNode[] = graph.nodes.map((node, index) => ({
      ...node,
      x: 90 + (index % 5) * 120,
      y: 90 + Math.floor(index / 5) * 80
    }));
    const simulationLinks: GraphSimulationLink[] = graph.links.map((link) => ({ ...link }));
    nodesRef.current = simulationNodes;

    let frame = 0;
    const simulation = forceSimulation(simulationNodes)
      .force(
        "link",
        forceLink<GraphSimulationNode, GraphSimulationLink>(simulationLinks)
          .id((node: GraphSimulationNode) => node.id)
          .distance((link) => {
            const sourceWeight = typeof link.source === "object" ? link.source.weight : 1;
            const targetWeight = typeof link.target === "object" ? link.target.weight : 1;
            return 128 + (sourceWeight + targetWeight) * 10;
          })
          .strength(0.38)
      )
      .force("charge", forceManyBody<GraphSimulationNode>().strength((node: GraphSimulationNode) => -220 - node.weight * 32))
      .force("center", forceCenter<GraphSimulationNode>(size.width / 2, size.height / 2))
      .force("collide", forceCollide<GraphSimulationNode>((node: GraphSimulationNode) => getGraphNodeCollisionRadius(node)).iterations(2))
      .alphaDecay(0.032);
    simulationRef.current = simulation;

    const flushLayout = () => {
      frame = 0;
      stabilizeNodeLayout(simulationNodes, size.width, size.height);
      setLayout({
        nodes: simulationNodes.map((node) => ({
          ...node,
          x: clamp(node.x, 30, size.width - 30),
          y: clamp(node.y, 30, size.height - 30)
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
      simulationRef.current = null;
      simulation.stop();
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [graph, size.height, size.width]);

  useEffect(() => {
    if (!dragState) {
      return;
    }
    const moveDragNode = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return;
      }
      const point = toSvgPoint(event.clientX, event.clientY, hostRef.current, size.width, size.height, viewport);
      if (!point) {
        return;
      }
      const simulation = simulationRef.current;
      const targetNode = nodesRef.current.find((node) => node.id === dragState.nodeId);
      if (!simulation || !targetNode) {
        return;
      }
      targetNode.fx = clamp(point.x + dragState.offsetX, 28, size.width - 28);
      targetNode.fy = clamp(point.y + dragState.offsetY, 28, size.height - 28);
      simulation.alphaTarget(0.26).restart();
    };

    const finishDragNode = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return;
      }
      const simulation = simulationRef.current;
      const targetNode = nodesRef.current.find((node) => node.id === dragState.nodeId);
      if (targetNode) {
        targetNode.fx = undefined;
        targetNode.fy = undefined;
      }
      simulation?.alphaTarget(0);
      setDragState(null);
    };

    window.addEventListener("pointermove", moveDragNode);
    window.addEventListener("pointerup", finishDragNode);
    window.addEventListener("pointercancel", finishDragNode);
    return () => {
      window.removeEventListener("pointermove", moveDragNode);
      window.removeEventListener("pointerup", finishDragNode);
      window.removeEventListener("pointercancel", finishDragNode);
    };
  }, [dragState, size.height, size.width, viewport]);

  useEffect(() => {
    if (!panState) {
      return;
    }
    const moveCanvas = (event: PointerEvent) => {
      if (event.pointerId !== panState.pointerId) {
        return;
      }
      setViewport((current) => ({
        ...current,
        offsetX: panState.originOffsetX + (event.clientX - panState.startX),
        offsetY: panState.originOffsetY + (event.clientY - panState.startY)
      }));
    };
    const finishCanvas = (event: PointerEvent) => {
      if (event.pointerId !== panState.pointerId) {
        return;
      }
      setPanState(null);
    };
    window.addEventListener("pointermove", moveCanvas);
    window.addEventListener("pointerup", finishCanvas);
    window.addEventListener("pointercancel", finishCanvas);
    return () => {
      window.removeEventListener("pointermove", moveCanvas);
      window.removeEventListener("pointerup", finishCanvas);
      window.removeEventListener("pointercancel", finishCanvas);
    };
  }, [panState]);

  const nodeMap = new Map(layout.nodes.map((node) => [node.id, node]));
  const activeNodeId = hoveredNodeId ?? selectedNodeId;
  const highlightedNodeIds = new Set<string>();
  const highlightedLinkIds = new Set<string>();
  if (activeNodeId) {
    highlightedNodeIds.add(activeNodeId);
  }
  for (const [index, link] of layout.links.entries()) {
    const sourceId = typeof link.source === "string" ? link.source : link.source.id;
    const targetId = typeof link.target === "string" ? link.target : link.target.id;
    if (activeNodeId && (sourceId === activeNodeId || targetId === activeNodeId)) {
      highlightedNodeIds.add(sourceId);
      highlightedNodeIds.add(targetId);
      highlightedLinkIds.add(`${sourceId}-${targetId}-${index}`);
    }
  }
  const gradientId = `knowledge-graph-flow-${graph.nodes.length}-${graph.links.length}`;

  return (
    <div
      ref={hostRef}
      className="knowledge-graph-canvas"
      onWheel={(event) => {
        event.preventDefault();
        const point = toSvgPoint(event.clientX, event.clientY, hostRef.current, size.width, size.height, viewport);
        if (!point) {
          return;
        }
        const nextScale = clamp(viewport.scale * (event.deltaY < 0 ? 1.08 : 0.92), 0.55, 2.4);
        setViewport((current) => ({
          scale: nextScale,
          offsetX: current.offsetX - (point.rawX - current.offsetX) * (nextScale / current.scale - 1),
          offsetY: current.offsetY - (point.rawY - current.offsetY) * (nextScale / current.scale - 1)
        }));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || dragState) {
          return;
        }
        const target = event.target as HTMLElement;
        if (target.closest(".knowledge-graph-node-group")) {
          return;
        }
        setPanState({
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          originOffsetX: viewport.offsetX,
          originOffsetY: viewport.offsetY
        });
      }}
    >
      <svg viewBox={`0 0 ${size.width} ${size.height}`} className="knowledge-graph-svg" aria-label="知识网络工作台">
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="rgba(255,255,255,0)" />
            <stop offset="50%" stopColor="rgba(255,255,255,0.78)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0)" />
          </linearGradient>
        </defs>
        <g transform={`translate(${viewport.offsetX} ${viewport.offsetY}) scale(${viewport.scale})`}>
        {layout.links.map((link, index) => {
          const sourceId = typeof link.source === "string" ? link.source : link.source.id;
          const targetId = typeof link.target === "string" ? link.target : link.target.id;
          const source = nodeMap.get(sourceId);
          const target = nodeMap.get(targetId);
          if (!source || !target) {
            return null;
          }
          const linkId = `${sourceId}-${targetId}-${index}`;
          const highlighted = highlightedLinkIds.has(linkId);
          const dimmed = activeNodeId !== null && !highlighted;
          return (
            <g key={`${sourceId}-${targetId}-${index}`}>
              <line
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                className={
                  highlighted
                    ? "knowledge-graph-link knowledge-graph-link-active"
                    : dimmed
                      ? "knowledge-graph-link knowledge-graph-link-dimmed"
                      : "knowledge-graph-link"
                }
              />
              <line
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                className={
                  highlighted
                    ? "knowledge-graph-link-flow knowledge-graph-link-flow-active"
                    : dimmed
                      ? "knowledge-graph-link-flow knowledge-graph-link-flow-dimmed"
                      : "knowledge-graph-link-flow"
                }
                stroke={`url(#${gradientId})`}
              />
            </g>
          );
        })}
        {layout.nodes.map((node) => {
          const radius = getGraphNodeRadius(node);
          const active = selectedNodeId === node.id;
          const hovered = hoveredNodeId === node.id;
          const emphasized = true;
          const dimmed = activeNodeId !== null && !highlightedNodeIds.has(node.id);
          return (
            <g
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
              className={dragState?.nodeId === node.id ? "knowledge-graph-node-group knowledge-graph-node-group-dragging" : "knowledge-graph-node-group"}
              onClick={() => onSelectNode(node.id)}
              onMouseEnter={() => onHoverNode(node.id)}
              onMouseLeave={() => onHoverNode(null)}
              onPointerDown={(event) => {
                if (event.button !== 0) {
                  return;
                }
                const point = toSvgPoint(event.clientX, event.clientY, hostRef.current, size.width, size.height, viewport);
                if (!point) {
                  return;
                }
                event.preventDefault();
                const simulation = simulationRef.current;
                const targetNode = nodesRef.current.find((item) => item.id === node.id);
                if (targetNode) {
                  targetNode.fx = node.x;
                  targetNode.fy = node.y;
                }
                simulation?.alphaTarget(0.26).restart();
                setDragState({
                  nodeId: node.id,
                  pointerId: event.pointerId,
                  offsetX: node.x - point.x,
                  offsetY: node.y - point.y
                });
              }}
            >
              <circle
                r={radius}
                className={
                  active || hovered
                    ? "knowledge-graph-node knowledge-graph-node-active"
                    : dimmed
                      ? `${getGraphNodeClass(node)} knowledge-graph-node-dimmed`
                      : getGraphNodeClass(node)
                }
              />
              {emphasized ? (
                <text textAnchor="middle" y={radius + 18} className="knowledge-graph-node-label">
                  {truncateGraphLabel(node.label)}
                </text>
              ) : null}
            </g>
          );
        })}
        </g>
      </svg>
    </div>
  );
}

function parseGraphPreview(artifact: StudioArtifact | null) {
  if (!artifact?.previewJson) {
    return null;
  }
  try {
    return JSON.parse(artifact.previewJson) as GraphPreviewPayload;
  } catch {
    return null;
  }
}

function getGraphNodeRadius(node: GraphNodeRecord) {
  if (isGraphHub(node.label)) {
    return 26;
  }
  return 14 + Math.min(node.weight, 7) * 2;
}

function getGraphNodeCollisionRadius(node: GraphNodeRecord) {
  const radius = getGraphNodeRadius(node);
  const labelWidth = Math.min(180, Math.max(64, node.label.length * 8));
  return Math.max(radius + 18, labelWidth / 2);
}

function getGraphNodeClass(node: GraphNodeRecord) {
  return isGraphHub(node.label) ? "knowledge-graph-node knowledge-graph-node-hub" : "knowledge-graph-node";
}

function isGraphHub(label: string) {
  return /readme|index|总结|总览|概述/i.test(label);
}

function truncateGraphLabel(label: string) {
  return label;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function toSvgPoint(
  clientX: number,
  clientY: number,
  host: HTMLDivElement | null,
  width: number,
  height: number,
  viewport: GraphViewportState
) {
  if (!host) {
    return null;
  }
  const rect = host.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return null;
  }
  const rawX = ((clientX - rect.left) / rect.width) * width;
  const rawY = ((clientY - rect.top) / rect.height) * height;
  return {
    rawX,
    rawY,
    x: (rawX - viewport.offsetX) / viewport.scale,
    y: (rawY - viewport.offsetY) / viewport.scale
  };
}

function stabilizeNodeLayout(nodes: GraphSimulationNode[], width: number, height: number) {
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < nodes.length; i += 1) {
      const current = nodes[i];
      const currentRadius = getGraphNodeCollisionRadius(current);
      current.x = clamp(current.x, currentRadius, width - currentRadius);
      current.y = clamp(current.y, currentRadius, height - currentRadius);
      for (let j = i + 1; j < nodes.length; j += 1) {
        const next = nodes[j];
        const nextRadius = getGraphNodeCollisionRadius(next);
        const dx = next.x - current.x;
        const dy = next.y - current.y;
        const distance = Math.hypot(dx, dy) || 0.001;
        const minimumDistance = currentRadius + nextRadius + 10;
        if (distance >= minimumDistance) {
          continue;
        }
        const push = (minimumDistance - distance) / 2;
        const unitX = dx / distance;
        const unitY = dy / distance;
        current.x = clamp(current.x - unitX * push, currentRadius, width - currentRadius);
        current.y = clamp(current.y - unitY * push, currentRadius, height - currentRadius);
        next.x = clamp(next.x + unitX * push, nextRadius, width - nextRadius);
        next.y = clamp(next.y + unitY * push, nextRadius, height - nextRadius);
      }
    }
  }
}
