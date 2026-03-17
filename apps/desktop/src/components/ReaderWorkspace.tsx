import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Block, Document, ReaderState, SourcePreview } from "@knowledgeos/shared-types";
import { getSourcePreview, listBlocks, updateBlock, upsertReaderState } from "../lib/commands/client";
import { MarkdownArticle } from "./MarkdownArticle";

interface ReaderWorkspaceProps {
  projectId: string;
  documents: Document[];
  bootstrapBlocks: Block[];
  readerStates: ReaderState[];
}

export function ReaderWorkspace({
  projectId,
  documents,
  bootstrapBlocks,
  readerStates
}: ReaderWorkspaceProps) {
  const queryClient = useQueryClient();
  const projectDocuments = documents.filter((document) => document.projectId === projectId);
  const persistedReaderState = readerStates.find((item) => item.projectId === projectId) ?? null;
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(persistedReaderState?.documentId ?? null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(persistedReaderState?.blockId ?? null);
  const [activePreview, setActivePreview] = useState<SourcePreview | null>(null);
  const [draftNote, setDraftNote] = useState("");

  useEffect(() => {
    if (!selectedDocumentId && projectDocuments[0]) {
      setSelectedDocumentId(persistedReaderState?.documentId ?? projectDocuments[0].documentId);
    }
  }, [persistedReaderState?.documentId, projectDocuments, selectedDocumentId]);

  const fallbackBlocks = useMemo(
    () => bootstrapBlocks.filter((block) => block.documentId === selectedDocumentId),
    [bootstrapBlocks, selectedDocumentId]
  );

  const blocksQuery = useQuery({
    queryKey: ["document-blocks", selectedDocumentId],
    queryFn: async () => listBlocks(selectedDocumentId!),
    enabled: Boolean(selectedDocumentId),
    initialData: selectedDocumentId ? { blocks: fallbackBlocks } : undefined
  });

  const blocks = blocksQuery.data?.blocks ?? [];
  const currentDocument = projectDocuments.find((document) => document.documentId === selectedDocumentId) ?? null;
  const currentBlock = blocks.find((block) => block.blockId === selectedBlockId) ?? null;

  useEffect(() => {
    if (!blocks.length) {
      setSelectedBlockId(null);
      setDraftNote("");
      return;
    }

    const persistedBlockId =
      persistedReaderState?.documentId === selectedDocumentId ? persistedReaderState.blockId : null;
    const nextBlock =
      blocks.find((block) => block.blockId === selectedBlockId) ??
      blocks.find((block) => block.blockId === persistedBlockId) ??
      blocks[0];

    if (nextBlock.blockId !== selectedBlockId) {
      setSelectedBlockId(nextBlock.blockId);
    }
    setDraftNote(nextBlock.note ?? "");
  }, [blocks, persistedReaderState?.blockId, persistedReaderState?.documentId, selectedBlockId, selectedDocumentId]);

  const readerStateMutation = useMutation({
    mutationFn: upsertReaderState,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
    }
  });

  useEffect(() => {
    if (!currentDocument || !currentBlock) {
      return;
    }
    readerStateMutation.mutate({
      projectId,
      documentId: currentDocument.documentId,
      blockId: currentBlock.blockId,
      sourceAnchor: currentBlock.sourceAnchor ?? undefined
    });
  }, [currentBlock?.blockId, currentDocument?.documentId, projectId]);

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
      await queryClient.invalidateQueries({ queryKey: ["document-blocks", selectedDocumentId] });
    }
  });

  if (!projectId) {
    return (
      <section className="reader-shell">
        <div className="reader-empty">先在左侧创建并打开一个项目。</div>
      </section>
    );
  }

  if (projectDocuments.length === 0) {
    return (
      <section className="reader-shell">
        <div className="reader-empty">当前项目还没有资料。先从左侧导入文档，再进入阅读器。</div>
      </section>
    );
  }

  if (!currentDocument) {
    return (
      <section className="reader-shell">
        <div className="reader-empty">请选择一个文档进入阅读流。</div>
      </section>
    );
  }

  if (!["chunked", "indexed", "ready"].includes(currentDocument.parseStatus)) {
    return (
      <section className="reader-shell">
        <div className="reader-empty">
          当前文档状态为 {currentDocument.parseStatus}。先在左侧任务队列里运行 `document.chunk`，阅读器就会进入可读状态。
        </div>
      </section>
    );
  }

  return (
    <section className="reader-shell">
      <aside className="reader-column reader-outline-panel">
        <div className="reader-panel-header">
          <div>
            <p className="section-kicker">Outline</p>
            <h3>阅读目录</h3>
          </div>
          <span>{blocks.length} 个块</span>
        </div>
        <div className="reader-document-switcher">
          {projectDocuments.map((document) => (
            <button
              key={document.documentId}
              className={document.documentId === currentDocument.documentId ? "reader-chip reader-chip-active" : "reader-chip"}
              onClick={() => {
                setSelectedDocumentId(document.documentId);
                setActivePreview(null);
              }}
            >
              {document.title ?? document.sourcePath}
            </button>
          ))}
        </div>
        <ul className="reader-outline-list">
          {blocks.map((block) => (
            <li key={block.blockId}>
              <button
                className={block.blockId === currentBlock?.blockId ? "outline-item outline-item-active" : "outline-item"}
                onClick={() => setSelectedBlockId(block.blockId)}
              >
                <span className="outline-depth" style={{ width: `${block.depth * 12 + 12}px` }} />
                <div>
                  <strong>{block.title ?? `Block ${block.orderIndex + 1}`}</strong>
                  <small>{block.tokenCount} tokens</small>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="reader-column reader-content-panel">
        {currentBlock ? (
          <>
            <header className="reader-content-header">
              <div>
                <p className="section-kicker">Reading</p>
                <h2>{currentBlock.title ?? `Block ${currentBlock.orderIndex + 1}`}</h2>
              </div>
              <div className="block-meta-cluster">
                <span>{currentBlock.blockType}</span>
                <span>{currentBlock.tokenCount} tokens</span>
                <span>{currentBlock.sourceAnchor ?? "无锚点"}</span>
              </div>
            </header>
            <MarkdownArticle content={currentBlock.contentMd} />
          </>
        ) : (
          <div className="reader-empty">当前文档还没有可显示的块。</div>
        )}
      </section>

      <aside className="reader-column reader-ai-panel">
        {currentBlock ? (
          <>
            <div className="reader-panel-header">
              <div>
                <p className="section-kicker">AI Studio</p>
                <h3>块级对话</h3>
              </div>
              <span>{currentBlock.isFavorite ? "已收藏" : "未收藏"}</span>
            </div>

            <div className="conversation-thread">
              <article className="message-bubble message-bubble-system">
                当前还没有接入远程模型 API。这里先保留成正式的 AI 对话位，后续会在这里展示块级解释、追问和卡片生成。
              </article>
              <article className="message-bubble message-bubble-user">
                请解释这个块在整份资料中的作用，并指出先修知识。
              </article>
              <article className="message-bubble message-bubble-assistant">
                当前块来源于：{currentDocument.title ?? currentDocument.sourcePath}
                <br />
                标题路径：{currentBlock.headingPath.join(" / ") || "未命名"}
              </article>
            </div>

            <div className="studio-grid">
              <button className="studio-tile">入门解释</button>
              <button className="studio-tile">考试视角</button>
              <button className="studio-tile">科研视角</button>
              <button className="studio-tile">生成卡片</button>
            </div>

            <div className="inspector-card">
              <div className="panel-heading">
                <div>
                  <p className="section-kicker">Source</p>
                  <h4>原文定位</h4>
                </div>
              </div>
              <p className="muted-copy">来源路径：{currentDocument.sourcePath}</p>
              <div className="button-row">
                <button
                  className="secondary"
                  disabled={!currentBlock.sourceAnchor || sourcePreviewMutation.isPending}
                  onClick={() => {
                    if (!currentBlock.sourceAnchor) {
                      return;
                    }
                    sourcePreviewMutation.mutate({
                      documentId: currentDocument.documentId,
                      anchor: currentBlock.sourceAnchor
                    });
                  }}
                >
                  定位原文
                </button>
                <button
                  className="secondary"
                  onClick={() =>
                    blockUpdateMutation.mutate({
                      blockId: currentBlock.blockId,
                      isFavorite: !currentBlock.isFavorite,
                      note: draftNote || undefined
                    })
                  }
                >
                  {currentBlock.isFavorite ? "取消收藏" : "收藏 Block"}
                </button>
              </div>
            </div>

            <label className="note-field">
              <span>我的备注</span>
              <textarea value={draftNote} onChange={(event) => setDraftNote(event.target.value)} rows={6} />
            </label>
            <div className="button-row">
              <button
                onClick={() =>
                  blockUpdateMutation.mutate({
                    blockId: currentBlock.blockId,
                    isFavorite: currentBlock.isFavorite,
                    note: draftNote || undefined
                  })
                }
                disabled={blockUpdateMutation.isPending}
              >
                保存备注
              </button>
            </div>

            <div className="inspector-card">
              <div className="panel-heading">
                <div>
                  <p className="section-kicker">Preview</p>
                  <h4>原文片段</h4>
                </div>
              </div>
              {activePreview ? (
                <MarkdownArticle content={activePreview.excerptMd} />
              ) : (
                <p className="muted-copy">点击“定位原文”后，这里会显示与当前锚点对应的原文片段。</p>
              )}
            </div>
          </>
        ) : (
          <div className="reader-empty">请选择一个块开始阅读。</div>
        )}
      </aside>
    </section>
  );
}
