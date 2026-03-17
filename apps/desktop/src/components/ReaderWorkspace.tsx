import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Block, Document, Project, ReaderState, SourcePreview } from "@knowledgeos/shared-types";
import { getSourcePreview, listBlocks, updateBlock, upsertReaderState } from "../lib/commands/client";
import { ExplainPanel } from "./explain/ExplainPanel";
import { MarkdownArticle } from "./MarkdownArticle";

interface ReaderWorkspaceProps {
  currentProject: Project | null;
  documents: Document[];
  currentDocument: Document | null;
  onSelectDocument: (documentId: string | null) => void;
  bootstrapBlocks: Block[];
  readerStates: ReaderState[];
}

export function ReaderWorkspace({
  currentProject,
  documents,
  currentDocument,
  onSelectDocument,
  bootstrapBlocks,
  readerStates
}: ReaderWorkspaceProps) {
  const queryClient = useQueryClient();
  const persistedReaderState = readerStates.find((item) => item.projectId === currentProject?.projectId) ?? null;
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(persistedReaderState?.blockId ?? null);
  const [activePreview, setActivePreview] = useState<SourcePreview | null>(null);
  const [draftNote, setDraftNote] = useState("");

  const fallbackBlocks = useMemo(
    () => bootstrapBlocks.filter((block) => block.documentId === currentDocument?.documentId),
    [bootstrapBlocks, currentDocument?.documentId]
  );

  const blocksQuery = useQuery({
    queryKey: ["document-blocks", currentDocument?.documentId],
    queryFn: async () => listBlocks(currentDocument!.documentId),
    enabled: Boolean(currentDocument?.documentId),
    initialData: currentDocument ? { blocks: fallbackBlocks } : undefined
  });

  const blocks = blocksQuery.data?.blocks ?? [];
  const currentBlock = blocks.find((block) => block.blockId === selectedBlockId) ?? blocks[0] ?? null;
  const readyDocumentCount = documents.filter((item) => ["chunked", "indexed", "ready"].includes(item.parseStatus)).length;
  const totalBlocks = currentProject
    ? bootstrapBlocks.filter((block) => block.projectId === currentProject.projectId).length
    : 0;

  useEffect(() => {
    if (!blocks.length) {
      setSelectedBlockId(null);
      setDraftNote("");
      return;
    }
    const persistedBlockId =
      persistedReaderState && persistedReaderState.documentId === currentDocument?.documentId
        ? persistedReaderState.blockId
        : null;
    const nextBlock =
      blocks.find((block) => block.blockId === selectedBlockId)
      ?? blocks.find((block) => block.blockId === persistedBlockId)
      ?? blocks[0];
    if (nextBlock.blockId !== selectedBlockId) {
      setSelectedBlockId(nextBlock.blockId);
    }
    setDraftNote(nextBlock.note ?? "");
  }, [blocks, currentDocument?.documentId, persistedReaderState, selectedBlockId]);

  const readerStateMutation = useMutation({
    mutationFn: upsertReaderState,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
    }
  });

  useEffect(() => {
    if (!currentProject || !currentDocument || !currentBlock) {
      return;
    }
    readerStateMutation.mutate({
      projectId: currentProject.projectId,
      documentId: currentDocument.documentId,
      blockId: currentBlock.blockId,
      sourceAnchor: currentBlock.sourceAnchor ?? undefined
    });
  }, [currentBlock?.blockId, currentDocument?.documentId, currentProject?.projectId]);

  const sourcePreviewMutation = useMutation({
    mutationFn: getSourcePreview,
    onSuccess: (result) => {
      setActivePreview(result.preview);
    }
  });

  const blockUpdateMutation = useMutation({
    mutationFn: updateBlock,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
      await queryClient.invalidateQueries({ queryKey: ["document-blocks", currentDocument?.documentId] });
    }
  });

  return (
    <>
      <section className="main-pane">
        <header className="workspace-header">
          <div className="workspace-copy">
            <div className="workspace-kicker">WORKSPACE</div>
            <h1>{currentProject?.name ?? "未选择项目"}</h1>
            <p>{currentProject?.rootPath ?? "先从左侧项目库中选择一个项目。"}</p>
          </div>

          <div className="workspace-metrics">
            <div className="metric-box">
              <span>文档</span>
              <strong>{documents.length}</strong>
            </div>
            <div className="metric-box">
              <span>可阅读</span>
              <strong>{readyDocumentCount}</strong>
            </div>
            <div className="metric-box">
              <span>Blocks</span>
              <strong>{totalBlocks}</strong>
            </div>
          </div>
        </header>

        <div className="document-stage">
          {!currentProject ? (
            <div className="surface-empty">先在左侧创建并打开一个项目。</div>
          ) : documents.length === 0 ? (
            <div className="surface-empty">当前项目没有资料。先从左侧导入文档。</div>
          ) : !currentDocument ? (
            <div className="surface-empty">请在左侧项目树中选择一份文档。</div>
          ) : !["chunked", "indexed", "ready"].includes(currentDocument.parseStatus) ? (
            <div className="surface-empty">
              当前文档状态为 {currentDocument.parseStatus}。先在左侧任务队列里运行 `document.chunk`。
            </div>
          ) : (
            <div className="document-scroll">
              <div className="document-tabbar">
                {documents.map((document) => (
                  <button
                    key={document.documentId}
                    className={document.documentId === currentDocument.documentId ? "document-tab document-tab-active" : "document-tab"}
                    onClick={() => onSelectDocument(document.documentId)}
                  >
                    {document.title ?? document.sourcePath.split(/[/\\]/).pop()}
                  </button>
                ))}
              </div>

              <div className="document-body">
                {blocks.length === 0 ? (
                  <div className="surface-empty">当前文档还没有生成可阅读的块。</div>
                ) : (
                  blocks.map((block) => (
                    <section
                      key={block.blockId}
                      className={block.blockId === currentBlock?.blockId ? "knowledge-block knowledge-block-active" : "knowledge-block"}
                      onClick={() => setSelectedBlockId(block.blockId)}
                    >
                      <div className="block-actions">
                        <button
                          className="block-action-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            blockUpdateMutation.mutate({
                              blockId: block.blockId,
                              isFavorite: !block.isFavorite,
                              note: block.note ?? undefined
                            });
                          }}
                        >
                          {block.isFavorite ? "★" : "☆"}
                        </button>
                        <button
                          className="block-action-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (!currentDocument || !block.sourceAnchor) {
                              return;
                            }
                            sourcePreviewMutation.mutate({
                              documentId: currentDocument.documentId,
                              anchor: block.sourceAnchor
                            });
                          }}
                        >
                          ↗
                        </button>
                        <button className="block-action-button">AI</button>
                      </div>

                      <div className="block-kicker">{block.headingPath.join(" / ") || "BLOCK"}</div>
                      <h3>{block.title ?? `Block ${block.orderIndex + 1}`}</h3>
                      <div className="block-meta">
                        <span>{block.blockType}</span>
                        <span>{block.tokenCount} tokens</span>
                        <span>{block.sourceAnchor ?? "无锚点"}</span>
                      </div>
                      <MarkdownArticle content={block.contentMd} />
                    </section>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      <aside className="chat-pane">
        <div className="chat-pane-header">
          <span>AI Chat</span>
          <div className="chat-pane-actions">
            <button className="pane-button">Tt</button>
            <button className="pane-button">清空</button>
          </div>
        </div>

        <div className="chat-pane-body">
          <div className="chat-card">
            <div className="chat-card-title">Welcome to KnowledgeOS</div>
            <p>这里是块级 AI 对话面板。后续会围绕当前知识块提供解释、追问和卡片生成。</p>
          </div>

          <ExplainPanel currentBlock={currentBlock} />

          <div className="chat-section">
            <div className="chat-section-title">原文预览</div>
            <div className="preview-panel">
              {activePreview ? (
                <MarkdownArticle content={activePreview.excerptMd} />
              ) : (
                <p>点击中间块右上角的跳转按钮后，这里会显示锚点对应的原文片段。</p>
              )}
            </div>
          </div>

          <div className="chat-section">
            <div className="chat-section-title">块备注</div>
            <textarea
              className="note-editor"
              value={draftNote}
              onChange={(event) => setDraftNote(event.target.value)}
              rows={6}
              placeholder="记录你的理解、问题或复习提示"
            />
            <button
              className="gold-button"
              disabled={!currentBlock || blockUpdateMutation.isPending}
              onClick={() => {
                if (!currentBlock) {
                  return;
                }
                blockUpdateMutation.mutate({
                  blockId: currentBlock.blockId,
                  isFavorite: currentBlock.isFavorite,
                  note: draftNote || undefined
                });
              }}
            >
              保存备注
            </button>
          </div>
        </div>

        <div className="chat-input-shell">
          <textarea className="chat-input" rows={3} placeholder="Press Enter to send message" />
          <div className="chat-input-footer">
            <div className="chat-input-tools">
              <button className="pane-button">图</button>
              <button className="pane-button">剪</button>
              <button className="pane-button">网</button>
              <span className="model-name">Deepseek</span>
            </div>
            <button className="send-button">Send</button>
          </div>
        </div>
      </aside>
    </>
  );
}
