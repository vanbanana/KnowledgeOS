import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Card, GraphNode, Project, SearchResult } from "@knowledgeos/shared-types";
import {
  confirmRelation,
  getSubgraph,
  hybridSearchProject,
  listCards,
  removeRelation,
  suggestRelations,
  upsertRelation
} from "../lib/commands/client";

interface GraphWorkspaceProps {
  currentProject: Project | null;
  onJumpToBlock: (blockId: string) => void;
}

export function GraphWorkspace({ currentProject, onJumpToBlock }: GraphWorkspaceProps) {
  const queryClient = useQueryClient();
  const [searchText, setSearchText] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [manualTargetNodeId, setManualTargetNodeId] = useState("");
  const [manualRelationType, setManualRelationType] = useState("related");

  const cardsQuery = useQuery({
    queryKey: ["cards", currentProject?.projectId],
    queryFn: async () => listCards(currentProject!.projectId),
    enabled: Boolean(currentProject?.projectId)
  });

  const subgraphQuery = useQuery({
    queryKey: ["graph", currentProject?.projectId, searchText],
    queryFn: async () =>
      getSubgraph({
        projectId: currentProject!.projectId,
        nodeTypes: [],
        queryText: searchText || undefined,
        relationConfirmedOnly: false
      }),
    enabled: Boolean(currentProject?.projectId)
  });

  const searchQuery = useQuery({
    queryKey: ["graph-search", currentProject?.projectId, searchText],
    queryFn: async () => hybridSearchProject({ projectId: currentProject!.projectId, query: searchText }),
    enabled: Boolean(currentProject?.projectId && searchText.trim().length > 0)
  });

  const currentCards = cardsQuery.data?.cards ?? [];
  const nodes = subgraphQuery.data?.subgraph.nodes ?? [];
  const relations = subgraphQuery.data?.subgraph.relations ?? [];
  const currentNode = useMemo(
    () => nodes.find((item) => item.nodeId === selectedNodeId) ?? nodes[0] ?? null,
    [nodes, selectedNodeId]
  );
  const sourceCard = currentNode ? currentCards.find((item) => item.cardId === currentNode.sourceRef) ?? null : null;

  useEffect(() => {
    if (currentNode && currentNode.nodeId !== selectedNodeId) {
      setSelectedNodeId(currentNode.nodeId);
    }
  }, [currentNode, selectedNodeId]);

  const suggestMutation = useMutation({
    mutationFn: suggestRelations,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["graph", currentProject?.projectId, searchText] });
    }
  });

  const confirmMutation = useMutation({
    mutationFn: confirmRelation,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["graph", currentProject?.projectId, searchText] });
    }
  });

  const removeMutation = useMutation({
    mutationFn: removeRelation,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["graph", currentProject?.projectId, searchText] });
    }
  });

  const upsertMutation = useMutation({
    mutationFn: upsertRelation,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["graph", currentProject?.projectId, searchText] });
    }
  });

  if (!currentProject) {
    return <section className="workspace-generic-empty">先选择项目，再进入图谱页。</section>;
  }

  const positionedNodes = layoutNodes(nodes);

  return (
    <section className="workspace-grid">
      <aside className="workspace-sidepanel">
        <div className="workspace-panel-title">图谱搜索</div>
        <input className="plain-input" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="搜索节点或知识点" />
        <div className="workspace-panel-title">卡片来源</div>
        <select className="plain-input" value={selectedCardId ?? ""} onChange={(event) => setSelectedCardId(event.target.value || null)}>
          <option value="">选择卡片后生成建议关系</option>
          {currentCards.map((card) => (
            <option key={card.cardId} value={card.cardId}>
              {card.title}
            </option>
          ))}
        </select>
        <button
          className="gold-button"
          disabled={!selectedCardId || suggestMutation.isPending}
          onClick={() => selectedCardId && suggestMutation.mutate({ cardId: selectedCardId })}
        >
          生成关系建议
        </button>

        <div className="workspace-panel-title">搜索结果</div>
        <div className="workspace-list">
          {(searchQuery.data?.results ?? []).map((item) => (
            <button
              key={`${item.entityType}-${item.entityId}`}
              className="workspace-list-row"
              onClick={() => setSelectedNodeId(findNodeIdBySearch(item, nodes, currentCards))}
            >
              <strong>{item.title}</strong>
              <span>{item.source}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="workspace-editor workspace-editor-graph">
        <div className="editor-header">
          <div>
            <div className="workspace-kicker">GRAPH</div>
            <h2>{currentProject.name} 图谱</h2>
          </div>
        </div>

        <div className="graph-canvas">
          <svg viewBox="0 0 900 560" className="graph-svg">
            {relations.map((relation) => {
              const from = positionedNodes.find((item) => item.node.nodeId === relation.fromNodeId);
              const to = positionedNodes.find((item) => item.node.nodeId === relation.toNodeId);
              if (!from || !to) {
                return null;
              }
              return (
                <g key={relation.relationId}>
                  <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={relation.confirmedByUser ? "graph-line graph-line-confirmed" : "graph-line"} />
                  <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 6} className="graph-edge-label">
                    {relation.relationType}
                  </text>
                </g>
              );
            })}
            {positionedNodes.map(({ node, x, y }) => (
              <g key={node.nodeId} onClick={() => setSelectedNodeId(node.nodeId)} className="graph-node-group">
                <circle cx={x} cy={y} r={selectedNodeId === node.nodeId ? 34 : 28} className={selectedNodeId === node.nodeId ? "graph-node graph-node-active" : "graph-node"} />
                <text x={x} y={y + 4} textAnchor="middle" className="graph-node-label">
                  {truncateLabel(node.label)}
                </text>
              </g>
            ))}
          </svg>
        </div>
      </section>

      <aside className="workspace-preview">
        <div className="workspace-panel-title">节点详情</div>
        {currentNode ? (
          <>
            <div className="detail-card">
              <strong>{currentNode.label}</strong>
              <span>{currentNode.nodeType}</span>
              {sourceCard?.sourceBlockId ? (
                <button className="small-button" onClick={() => onJumpToBlock(sourceCard.sourceBlockId!)}>
                  跳回来源块
                </button>
              ) : null}
            </div>
            <div className="workspace-panel-title">相关关系</div>
            <div className="workspace-list">
              {relations
                .filter((item) => item.fromNodeId === currentNode.nodeId || item.toNodeId === currentNode.nodeId)
                .map((relation) => (
                  <div key={relation.relationId} className="workspace-list-row workspace-list-row-static">
                    <strong>{relation.relationType}</strong>
                    <span>{relation.confirmedByUser ? "已确认" : "待确认"}</span>
                    <div className="inline-button-row">
                      {!relation.confirmedByUser ? (
                        <button className="small-button" onClick={() => confirmMutation.mutate({ relationId: relation.relationId })}>
                          确认
                        </button>
                      ) : null}
                      <button className="small-button" onClick={() => removeMutation.mutate({ relationId: relation.relationId })}>
                        删除
                      </button>
                    </div>
                  </div>
                ))}
            </div>

            <div className="workspace-panel-title">手动新增关系</div>
            <select className="plain-input" value={manualTargetNodeId} onChange={(event) => setManualTargetNodeId(event.target.value)}>
              <option value="">选择目标节点</option>
              {nodes.filter((item) => item.nodeId !== currentNode.nodeId).map((item) => (
                <option key={item.nodeId} value={item.nodeId}>
                  {item.label}
                </option>
              ))}
            </select>
            <input className="plain-input" value={manualRelationType} onChange={(event) => setManualRelationType(event.target.value)} />
            <button
              className="gold-button"
              disabled={!manualTargetNodeId || upsertMutation.isPending}
              onClick={() =>
                upsertMutation.mutate({
                  projectId: currentProject.projectId,
                  fromNodeId: currentNode.nodeId,
                  toNodeId: manualTargetNodeId,
                  relationType: manualRelationType,
                  originType: "manual",
                  confirmedByUser: true
                })
              }
            >
              添加关系
            </button>
          </>
        ) : (
          <div className="empty-hint">当前项目还没有图谱节点。先在阅读器中生成卡片。</div>
        )}
      </aside>
    </section>
  );
}

function layoutNodes(nodes: GraphNode[]) {
  return nodes.map((node, index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    return {
      node,
      x: 160 + column * 260,
      y: 110 + row * 140
    };
  });
}

function truncateLabel(label: string) {
  return label.length > 8 ? `${label.slice(0, 8)}…` : label;
}

function findNodeIdBySearch(result: SearchResult, nodes: GraphNode[], cards: Card[]) {
  if (result.entityType === "card") {
    return nodes.find((item) => item.sourceRef === result.entityId)?.nodeId ?? null;
  }
  if (result.entityType === "block") {
    const card = cards.find((item) => item.sourceBlockId === result.entityId);
    return nodes.find((item) => item.sourceRef === card?.cardId)?.nodeId ?? null;
  }
  return nodes[0]?.nodeId ?? null;
}
