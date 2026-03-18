import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import type { Block, Document, Project } from "@knowledgeos/shared-types";
import { chatWithBlock, deleteBlock, insertNoteBlock, listBlocks, updateBlock, upsertReaderState } from "../lib/commands/client";
import { MarkdownArticle } from "./MarkdownArticle";

interface ReaderWorkspaceProps {
  currentProject: Project | null;
  documents: Document[];
  currentDocument: Document | null;
  onSelectDocument: (documentId: string | null) => void;
  bootstrapBlocks: Block[];
}

interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
  isStreaming?: boolean;
}

interface ChatStreamEventPayload {
  requestId: string;
  chunk: string;
  done: boolean;
  error?: string | null;
}

interface DragInsertPayload {
  contentMd: string;
  title?: string;
  sourceKind: "block" | "selection";
}

interface DragPreviewState {
  x: number;
  y: number;
  title: string;
}

export function ReaderWorkspace({
  currentProject,
  documents,
  currentDocument,
  onSelectDocument,
  bootstrapBlocks
}: ReaderWorkspaceProps) {
  const queryClient = useQueryClient();
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [referencedBlockId, setReferencedBlockId] = useState<string | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [draggingMessageId, setDraggingMessageId] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);
  const [openDocumentIds, setOpenDocumentIds] = useState<string[]>(() =>
    currentDocument ? [currentDocument.documentId] : []
  );
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [editingBlockTitle, setEditingBlockTitle] = useState("");
  const [editingBlockContent, setEditingBlockContent] = useState("");
  const currentRequestIdRef = useRef<string | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const blockStackRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const documentBlocksRef = useRef<HTMLDivElement | null>(null);
  const dragCandidateRef = useRef<{
    messageId: string;
    host: HTMLDivElement;
    message: ChatMessage;
    payload: DragInsertPayload;
    allowLiveSelection: boolean;
    pendingBlockDrag: boolean;
    startX: number;
    startY: number;
  } | null>(null);
  const dragPayloadRef = useRef<DragInsertPayload | null>(null);
  const dragPointerRef = useRef({ x: 0, y: 0 });

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
  const currentBlock = blocks.find((block) => block.blockId === selectedBlockId) ?? null;
  const referencedBlock = referencedBlockId
    ? blocks.find((block) => block.blockId === referencedBlockId) ?? null
    : null;
  const openDocuments = useMemo(
    () => openDocumentIds
      .map((documentId) => documents.find((document) => document.documentId === documentId) ?? null)
      .filter((document): document is Document => Boolean(document)),
    [documents, openDocumentIds]
  );

  useEffect(() => {
    setOpenDocumentIds((current) => {
      const validIds = current.filter((documentId) => documents.some((document) => document.documentId === documentId));
      if (currentDocument && !validIds.includes(currentDocument.documentId)) {
        return [...validIds, currentDocument.documentId];
      }
      return validIds;
    });
  }, [currentDocument, documents]);

  useEffect(() => {
    if (editingBlockId && !blocks.some((block) => block.blockId === editingBlockId)) {
      setEditingBlockId(null);
      setEditingBlockTitle("");
      setEditingBlockContent("");
    }
  }, [blocks, editingBlockId]);

  useEffect(() => {
    setSelectedBlockId(null);
    setReferencedBlockId(null);
    setEditingBlockId(null);
    setEditingBlockTitle("");
    setEditingBlockContent("");
  }, [currentDocument?.documentId]);

  useEffect(() => {
    if (!blocks.length) {
      setSelectedBlockId(null);
      setReferencedBlockId(null);
      return;
    }

    if (selectedBlockId && !blocks.some((block) => block.blockId === selectedBlockId)) {
      setSelectedBlockId(null);
    }

    if (referencedBlockId && !blocks.some((block) => block.blockId === referencedBlockId)) {
      setReferencedBlockId(null);
    }
  }, [blocks, referencedBlockId, selectedBlockId]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<ChatStreamEventPayload>("reader-chat-stream", (event) => {
      if (disposed) {
        return;
      }

      const payload = event.payload;
      if (payload.requestId !== currentRequestIdRef.current) {
        return;
      }

      if (payload.error) {
        setChatMessages((current) =>
          current.map((message) =>
            message.id === `assistant-${payload.requestId}`
              ? { ...message, content: `请求失败：${payload.error}`, isStreaming: false }
              : message
          )
        );
        currentRequestIdRef.current = null;
        return;
      }

      if (payload.chunk) {
        setChatMessages((current) =>
          current.map((message) =>
            message.id === `assistant-${payload.requestId}`
              ? { ...message, content: `${message.content}${payload.chunk}`, isStreaming: true }
              : message
          )
        );
      }

      if (payload.done) {
        setChatMessages((current) =>
          current.map((message) =>
            message.id === `assistant-${payload.requestId}`
              ? { ...message, isStreaming: false }
              : message
          )
        );
        currentRequestIdRef.current = null;
      }
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const element = chatInputRef.current;
    if (!element) {
      return;
    }
    const isEmpty = chatDraft.trim().length === 0;
    element.style.height = "0px";
    const nextHeight = isEmpty
      ? 32
      : Math.min(Math.max(element.scrollHeight, 32), 132);
    element.style.height = `${nextHeight}px`;
    element.style.overflowY = element.scrollHeight > 132 ? "auto" : "hidden";
  }, [chatDraft, referencedBlockId]);

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

  const blockUpdateMutation = useMutation({
    mutationFn: updateBlock,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
      await queryClient.invalidateQueries({ queryKey: ["document-blocks", currentDocument?.documentId] });
    }
  });

  const insertNoteBlockMutation = useMutation({
    mutationFn: insertNoteBlock,
    onSuccess: async (result) => {
      setDropIndex(null);
      setSelectedBlockId(result.block.blockId);
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
      await queryClient.invalidateQueries({ queryKey: ["document-blocks", currentDocument?.documentId] });
    }
  });

  const deleteBlockMutation = useMutation({
    mutationFn: deleteBlock,
    onSuccess: async (_, variables) => {
      const deletedIndex = blocks.findIndex((item) => item.blockId === variables.blockId);
      const nextBlock =
        blocks[deletedIndex + 1]
        ?? blocks[deletedIndex - 1]
        ?? null;
      if (selectedBlockId === variables.blockId) {
        setSelectedBlockId(nextBlock?.blockId ?? null);
      }
      if (referencedBlockId === variables.blockId) {
        setReferencedBlockId(null);
      }
      if (editingBlockId === variables.blockId) {
        setEditingBlockId(null);
        setEditingBlockTitle("");
        setEditingBlockContent("");
      }
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
      await queryClient.invalidateQueries({ queryKey: ["document-blocks", currentDocument?.documentId] });
    }
  });

  useEffect(() => {
    function resetDragState() {
      dragCandidateRef.current = null;
      dragPayloadRef.current = null;
      setDropIndex(null);
      setDraggingMessageId(null);
      setDragPreview(null);
      document.body.classList.remove("is-note-drag-pending");
      document.body.classList.remove("is-note-dragging");
      document.body.classList.remove("is-note-dragging-block");
    }

    function handleWindowMouseMove(event: MouseEvent) {
      const candidate = dragCandidateRef.current;
      if (!candidate) {
        return;
      }

      dragPointerRef.current = { x: event.clientX, y: event.clientY };

      if (!dragPayloadRef.current) {
        if (candidate.allowLiveSelection) {
          const livePayload = buildDragPayload(candidate.host, candidate.message);
          if (livePayload.sourceKind !== "selection") {
            return;
          }
          candidate.payload = livePayload;
        }

        const deltaX = event.clientX - candidate.startX;
        const deltaY = event.clientY - candidate.startY;
        const movedEnough = Math.hypot(deltaX, deltaY) > 8;
        if (!movedEnough) {
          return;
        }
        dragPayloadRef.current = candidate.payload;
        setDraggingMessageId(candidate.messageId);
        setDragPreview({
          x: event.clientX,
          y: event.clientY,
          title: candidate.payload.title ?? "AI 笔记"
        });
        document.body.classList.remove("is-note-drag-pending");
        document.body.classList.add("is-note-dragging");
        if (candidate.payload.sourceKind === "block") {
          document.body.classList.add("is-note-dragging-block");
          window.getSelection()?.removeAllRanges();
        }
      } else {
        setDragPreview((current) => current ? {
          ...current,
          x: event.clientX,
          y: event.clientY
        } : current);
      }

      const container = documentBlocksRef.current;
      event.preventDefault();
      if (!container || !currentDocument) {
        setDropIndex(null);
        return;
      }

      const rect = container.getBoundingClientRect();
      const insideX = event.clientX >= rect.left && event.clientX <= rect.right;
      const insideY = event.clientY >= rect.top && event.clientY <= rect.bottom;
      setDropIndex(insideX && insideY ? resolveDropIndex(event.clientY) : null);
      event.preventDefault();
    }

    function handleWindowMouseUp() {
      const payload = dragPayloadRef.current;
      const container = documentBlocksRef.current;
      const pointer = dragPointerRef.current;

      if (payload && container && currentDocument) {
        const rect = container.getBoundingClientRect();
        const insideX = pointer.x >= rect.left && pointer.x <= rect.right;
        const insideY = pointer.y >= rect.top && pointer.y <= rect.bottom;
        if (insideX && insideY) {
          const nextIndex = resolveDropIndex(pointer.y);
          const beforeBlockId = nextIndex < blocks.length ? blocks[nextIndex]?.blockId : undefined;
          insertNoteBlockMutation.mutate({
            documentId: currentDocument.documentId,
            beforeBlockId,
            title: payload.title,
            contentMd: payload.contentMd
          });
        }
      }

      resetDragState();
    }

    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", handleWindowMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", handleWindowMouseUp);
      document.body.classList.remove("is-note-drag-pending");
      document.body.classList.remove("is-note-dragging");
      document.body.classList.remove("is-note-dragging-block");
    };
  }, [blocks, currentDocument, insertNoteBlockMutation]);

  const chatMutation = useMutation({
    mutationFn: chatWithBlock,
    onSuccess: (result, variables) => {
      setChatMessages((current) =>
        current.map((message) =>
          message.id === `assistant-${variables.requestId}` && !message.content.trim()
            ? { ...message, content: result.answer, isStreaming: false }
            : message
        )
      );
    },
    onError: (error: Error, variables) => {
      setChatMessages((current) =>
        current.map((message) =>
          message.id === `assistant-${variables.requestId}`
            ? { ...message, content: `请求失败：${error.message}`, isStreaming: false }
            : message
        )
      );
      currentRequestIdRef.current = null;
    }
  });

  function handleSelectBlock(block: Block) {
    setSelectedBlockId(block.blockId);
    setReferencedBlockId(block.blockId);
  }

  function handleStartEditBlock(block: Block) {
    setEditingBlockId(block.blockId);
    setEditingBlockTitle(block.title ?? "");
    setEditingBlockContent(block.contentMd);
  }

  function handleCancelEditBlock() {
    setEditingBlockId(null);
    setEditingBlockTitle("");
    setEditingBlockContent("");
  }

  function handleCloseDocumentTab(documentId: string) {
    setOpenDocumentIds((current) => {
      const nextTabs = current.filter((item) => item !== documentId);
      if (currentDocument?.documentId !== documentId) {
        return nextTabs;
      }

      const closedIndex = current.indexOf(documentId);
      const fallbackDocumentId =
        nextTabs[Math.min(closedIndex, nextTabs.length - 1)]
        ?? nextTabs[closedIndex - 1]
        ?? null;

      onSelectDocument(fallbackDocumentId);
      return nextTabs;
    });
  }

  function buildDragPayload(host: HTMLDivElement, message: ChatMessage): DragInsertPayload {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() ?? "";
    const selectedInsideCurrent =
      selection?.rangeCount
      && host.contains(selection.anchorNode)
      && host.contains(selection.focusNode);
    const contentMd = selectedInsideCurrent && selectedText ? selectedText : message.content;
    const titleSource = contentMd.split("\n").find((line) => line.trim()) ?? "AI 笔记";
    const title = titleSource.replace(/^#+\s*/, "").trim().slice(0, 36) || "AI 笔记";
    return {
      contentMd,
      title,
      sourceKind: selectedInsideCurrent && selectedText ? "selection" : "block"
    };
  }

  function resolveDropIndex(clientY: number) {
    if (!blocks.length) {
      return 0;
    }

    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      const element = blockStackRefs.current.get(block.blockId);
      if (!element) {
        continue;
      }

      const rect = element.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        return index;
      }
    }

    return blocks.length;
  }
  function handleAssistantMouseDown(event: React.MouseEvent<HTMLDivElement>, message: ChatMessage) {
    if (event.button !== 0) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest("button, a")) {
      return;
    }

    const host = event.currentTarget;
    const initialPayload = buildDragPayload(host, message);
    const hasSelection = initialPayload.sourceKind === "selection";
    const startedInsideContent = Boolean(target.closest(".chat-message-content"));
    const startedOnTextualElement = Boolean(target.closest("p, li, h1, h2, h3, strong, code, span"));
    const startedFromBlockSurface = Boolean(target.closest(".chat-message-role")) || !startedInsideContent || !startedOnTextualElement;

    if (startedFromBlockSurface && !hasSelection) {
      event.preventDefault();
      document.body.classList.add("is-note-drag-pending");
      window.getSelection()?.removeAllRanges();
    }

    dragPointerRef.current = { x: event.clientX, y: event.clientY };
    dragCandidateRef.current = {
      messageId: message.id,
      host,
      message,
      payload: initialPayload,
      allowLiveSelection: startedInsideContent,
      pendingBlockDrag: startedFromBlockSurface,
      startX: event.clientX,
      startY: event.clientY
    };
  }

  return (
    <>
      <section className="main-pane">
        <div className="document-stage">
          {!currentProject ? (
            <div className="surface-empty">先在左侧创建并打开一个项目。</div>
          ) : documents.length === 0 ? (
            <div className="surface-empty">当前项目没有资料。先从左侧导入文档。</div>
          ) : openDocuments.length === 0 ? (
            <div className="document-blank-canvas">
              <div className="document-blank-canvas-hint">从左侧资源库打开文档</div>
            </div>
          ) : !currentDocument ? (
            <div className="surface-empty">请在左侧项目树中选择一份文档。</div>
          ) : !["chunked", "indexed", "ready"].includes(currentDocument.parseStatus) ? (
            <div className="surface-empty">正在把资料转换为可阅读内容。当前进度：{currentDocument.parseStatus}</div>
          ) : (
            <div className="document-shell">
              <div className="document-tabbar">
                {openDocuments.map((document) => (
                  <div
                    key={document.documentId}
                    className={document.documentId === currentDocument.documentId ? "document-tab document-tab-active" : "document-tab"}
                    onClick={() => onSelectDocument(document.documentId)}
                    title={getDocumentDisplayName(document)}
                  >
                    <span className="document-tab-label">{getDocumentDisplayName(document)}</span>
                    <button
                      className="document-tab-close"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleCloseDocumentTab(document.documentId);
                      }}
                      aria-label={`关闭 ${getDocumentDisplayName(document)}`}
                    >
                      <SvgCloseIcon />
                    </button>
                  </div>
                ))}
              </div>

              <div className="document-body document-scroll">
                {blocks.length === 0 ? (
                  <div className="surface-empty">当前文档还没有生成可阅读的块。</div>
                ) : (
                  <div className="document-blocks" ref={documentBlocksRef}>
                    {blocks.map((block, index) => (
                      <div
                        key={block.blockId}
                        className={
                          dropIndex !== null && index > dropIndex
                            ? "knowledge-block-stack knowledge-block-stack-shifted"
                            : "knowledge-block-stack"
                        }
                        ref={(element) => {
                          if (element) {
                            blockStackRefs.current.set(block.blockId, element);
                          } else {
                            blockStackRefs.current.delete(block.blockId);
                          }
                        }}
                      >
                        <div
                          className={dropIndex === index ? "block-drop-gap block-drop-gap-active" : "block-drop-gap"}
                        />
                        <section
                          className={[
                            "knowledge-block",
                            block.blockId === currentBlock?.blockId ? "knowledge-block-active" : "",
                            block.blockType === "note" ? "knowledge-block-note" : ""
                          ].filter(Boolean).join(" ")}
                          onClick={() => handleSelectBlock(block)}
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
                              aria-label={block.isFavorite ? "取消收藏" : "收藏"}
                              title={block.isFavorite ? "取消收藏" : "收藏"}
                            >
                              <SvgStarIcon active={block.isFavorite} />
                            </button>
                            <button
                              className="block-action-button"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleStartEditBlock(block);
                              }}
                              aria-label="改写"
                              title="改写"
                            >
                              <SvgEditIcon />
                            </button>
                            <button
                              className="block-action-button"
                              onClick={(event) => {
                                event.stopPropagation();
                                void deleteBlockMutation.mutateAsync({ blockId: block.blockId });
                              }}
                              aria-label="删除"
                              title="删除"
                            >
                              <SvgTrashIcon />
                            </button>
                            <button
                              className="block-action-button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setReferencedBlockId(block.blockId);
                              }}
                              aria-label="引用"
                              title="引用"
                            >
                              <SvgQuoteIcon />
                            </button>
                          </div>
                          {editingBlockId === block.blockId ? (
                            <div
                              className="block-editor"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <input
                                className="block-editor-title"
                                value={editingBlockTitle}
                                onChange={(event) => setEditingBlockTitle(event.target.value)}
                                placeholder="块标题"
                              />
                              <textarea
                                className="block-editor-textarea"
                                value={editingBlockContent}
                                onChange={(event) => setEditingBlockContent(event.target.value)}
                              />
                              <div className="block-editor-actions">
                                <button
                                  className="block-editor-button"
                                  onClick={() => handleCancelEditBlock()}
                                >
                                  取消
                                </button>
                                <button
                                  className="block-editor-button block-editor-button-primary"
                                  onClick={() => {
                                    void blockUpdateMutation.mutateAsync({
                                      blockId: block.blockId,
                                      title: editingBlockTitle.trim() ? editingBlockTitle.trim() : null,
                                      contentMd: editingBlockContent.trim() || block.contentMd,
                                      isFavorite: block.isFavorite,
                                      note: block.note ?? undefined
                                    }).then(() => {
                                      handleCancelEditBlock();
                                    });
                                  }}
                                >
                                  保存改写
                                </button>
                              </div>
                            </div>
                          ) : (
                            <MarkdownArticle content={block.contentMd} />
                          )}
                        </section>
                      </div>
                    ))}
                    <div
                      className={dropIndex === blocks.length ? "block-drop-gap block-drop-gap-active" : "block-drop-gap"}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      <aside className="chat-pane chat-pane-flat">
        <div className="chat-pane-header">
          <span>AI Chat</span>
        </div>

        <div className="chat-pane-body">
          <div className="chat-stream">
            {chatMessages.map((message) => (
              <div
                key={message.id}
                className={
                  message.role === "assistant"
                    ? [
                      `chat-message chat-message-${message.role}`,
                      "chat-message-card",
                      "chat-message-draggable",
                      message.isStreaming ? "chat-message-streaming" : "",
                      draggingMessageId === message.id ? "chat-message-dragging" : ""
                    ].filter(Boolean).join(" ")
                    : `chat-message chat-message-${message.role}`
                }
                onMouseDown={(event) => {
                  if (message.role !== "assistant") {
                    return;
                  }
                  handleAssistantMouseDown(event, message);
                }}
                onDragEnd={() => {
                  setDropIndex(null);
                  setDraggingMessageId(null);
                }}
              >
                <div className="chat-message-role">{message.role === "assistant" ? "AI" : "你"}</div>
                <div className="chat-message-content">
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
              </div>
            ))}
          </div>
        </div>

        <div
          className={
            referencedBlock
              ? "chat-input-shell chat-input-shell-flat chat-input-shell-has-reference"
              : "chat-input-shell chat-input-shell-flat"
          }
        >
          {referencedBlock ? (
            <div className="chat-reference-bar chat-reference-bar-overlay">
              <div className="chat-reference-chip">
                <span className="chat-reference-prefix">↓</span>
                <span className="chat-reference-title">{buildReferenceTitle(referencedBlock)}</span>
                <button
                  className="chat-reference-clear"
                  onClick={() => setReferencedBlockId(null)}
                >
                  ×
                </button>
              </div>
            </div>
          ) : null}

          <textarea
            ref={chatInputRef}
            className="chat-input chat-input-flat"
            rows={1}
            value={chatDraft}
            onChange={(event) => setChatDraft(event.target.value)}
            placeholder="输入问题"
          />
          <div className="chat-input-footer">
            <div className="chat-input-footer-spacer" />
            <button
              className="send-button"
              disabled={chatMutation.isPending}
              onClick={() => {
                const nextQuestion = chatDraft.trim() || (referencedBlock ? "请直接解析这个知识块。" : "请直接回答用户问题。");
                const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const nextHistory = chatMessages
                  .filter((item) => item.role === "user" || item.role === "assistant")
                  .slice(-6)
                  .map((item) => ({ role: item.role, content: item.content }));

                currentRequestIdRef.current = requestId;
                setChatMessages((current) => [
                  ...current,
                  {
                    id: `user-${Date.now()}`,
                    role: "user",
                    content: nextQuestion
                  },
                  {
                    id: `assistant-${requestId}`,
                    role: "assistant",
                    content: "",
                    isStreaming: true
                  }
                ]);
                setChatDraft("");
                chatMutation.mutate({
                  blockId: referencedBlock?.blockId,
                  question: nextQuestion,
                  requestId,
                  history: nextHistory
                });
              }}
            >
              发送
            </button>
          </div>
        </div>

        {dragPreview ? (
          <div
            className="chat-drag-preview"
            style={{
              left: dragPreview.x + 16,
              top: dragPreview.y + 16
            }}
          >
            {dragPreview.title}
          </div>
        ) : null}
      </aside>
    </>
  );
}

function buildReferenceTitle(block: Block) {
  return block.title ?? block.headingPath.at(-1) ?? `Block ${block.orderIndex + 1}`;
}

function getDocumentDisplayName(document: Document) {
  const rawName = document.title ?? document.sourcePath.split(/[/\\]/).pop() ?? document.sourcePath;
  return rawName.replace(/^[0-9a-f]{8}[-_]/i, "");
}

function SvgCloseIcon() {
  return (
    <svg className="inline-action-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4L12 12M12 4L4 12" />
    </svg>
  );
}

function SvgStarIcon({ active }: { active: boolean }) {
  return (
    <svg className={active ? "inline-action-icon inline-action-icon-active" : "inline-action-icon"} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.4L9.6 5.7L13.2 6.1L10.5 8.6L11.2 12.1L8 10.4L4.8 12.1L5.5 8.6L2.8 6.1L6.4 5.7L8 2.4Z" />
    </svg>
  );
}

function SvgEditIcon() {
  return (
    <svg className="inline-action-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 11.8L3.4 9.4L9.8 3L12.9 6.1L6.5 12.5L4.1 12.9H3V11.8Z" />
      <path d="M8.8 4L11.9 7.1" />
    </svg>
  );
}

function SvgTrashIcon() {
  return (
    <svg className="inline-action-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 4.5H12.5" />
      <path d="M6 2.8H10" />
      <path d="M5 4.5V12.2H11V4.5" />
      <path d="M6.8 6.3V10.7" />
      <path d="M9.2 6.3V10.7" />
    </svg>
  );
}

function SvgQuoteIcon() {
  return (
    <svg className="inline-action-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.7 5.2H3.8V8.1H6.1V10.8H3.4V8.7C3.4 6.6 4.2 5.4 5.7 5.2Z" />
      <path d="M11.8 5.2H9.9V8.1H12.2V10.8H9.5V8.7C9.5 6.6 10.3 5.4 11.8 5.2Z" />
    </svg>
  );
}
