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

  if (projectDocuments.length === 0) {
    return <section className="reader-shell"><div className="reader-empty">当前项目暂无可阅读文档。</div></section>;
  }

  if (!currentDocument) {
    return <section className="reader-shell"><div className="reader-empty">请选择一个文档进入阅读器。</div></section>;
  }

  if (currentDocument.parseStatus !== "chunked" && currentDocument.parseStatus !== "indexed" && currentDocument.parseStatus !== "ready") {
    return (
      <section className="reader-shell">
        <div className="reader-empty">
          当前文档状态为 {currentDocument.parseStatus}，请先运行 `document.chunk` 任务后再进入阅读器。
        </div>
      </section>
    );
  }

  return (
    <section className="reader-shell">
      <aside className="reader-column reader-sidebar">
        <div className="reader-header">
          <p className="eyebrow">Reader</p>
          <h2>文档与块目录</h2>
        </div>
        <div className="reader-documents">
          {projectDocuments.map((document) => (
            <button
              key={document.documentId}
              className={document.documentId === currentDocument.documentId ? "reader-doc reader-doc-active" : "reader-doc"}
              onClick={() => {
                setSelectedDocumentId(document.documentId);
                setActivePreview(null);
              }}
            >
              <strong>{document.title ?? document.sourcePath}</strong>
              <span>{document.parseStatus}</span>
            </button>
          ))}
        </div>
        <ul className="reader-outline">
          {blocks.map((block) => (
            <li key={block.blockId}>
              <button
                className={block.blockId === currentBlock?.blockId ? "reader-outline-item reader-outline-item-active" : "reader-outline-item"}
                onClick={() => setSelectedBlockId(block.blockId)}
                style={{ paddingLeft: `${1 + block.depth * 0.9}rem` }}
              >
                <span>{block.title ?? `Block ${block.orderIndex + 1}`}</span>
                <small>{block.tokenCount} tokens</small>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="reader-column reader-main">
        {currentBlock ? (
          <>
            <div className="reader-header">
              <p className="eyebrow">Current Block</p>
              <h2>{currentBlock.title ?? `Block ${currentBlock.orderIndex + 1}`}</h2>
              <p className="reader-meta">
                {currentBlock.blockType} / 锚点 {currentBlock.sourceAnchor ?? "无"} / {currentBlock.tokenCount} tokens
              </p>
            </div>
            <MarkdownArticle content={currentBlock.contentMd} />
          </>
        ) : (
          <div className="reader-empty">当前文档还没有可用的 block。</div>
        )}
      </section>

      <aside className="reader-column reader-panel">
        {currentBlock ? (
          <>
            <div className="reader-header">
              <p className="eyebrow">Inspector</p>
              <h2>原文定位与标注</h2>
            </div>
            <div className="inspector-card">
              <p className="reader-meta">来源路径：{currentDocument.sourcePath}</p>
              <p className="reader-meta">标题路径：{currentBlock.headingPath.join(" / ") || "未命名"}</p>
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
              <span>备注</span>
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
              <h3>原文预览</h3>
              {activePreview ? (
                <MarkdownArticle content={activePreview.excerptMd} />
              ) : (
                <p className="reader-meta">点击“定位原文”后，这里会显示与当前锚点对应的原文片段。</p>
              )}
            </div>
          </>
        ) : (
          <div className="reader-empty">请选择一个 block。</div>
        )}
      </aside>
    </section>
  );
}
