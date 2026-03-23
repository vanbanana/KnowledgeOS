import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import type { Block, BlockExplanation, Document, GetAgentAuditOutput, Project } from "@knowledgeos/shared-types";
import {
  chatWithBlock,
  confirmAgentTask,
  deleteBlock,
  explainBlock,
  generateAgentPreview,
  getAgentAudit,
  insertNoteBlock,
  listDocumentBlockExplanations,
  listBlocks,
  planAgentTask,
  updateBlock,
  upsertReaderState
} from "../lib/commands/client";
import { MarkdownArticle } from "./MarkdownArticle";

interface ReaderWorkspaceProps {
  currentProject: Project | null;
  documents: Document[];
  currentDocument: Document | null;
  onSelectDocument: (documentId: string | null) => void;
  bootstrapBlocks: Block[];
  paperAnalyzeTrigger: number;
}

interface ChatMessage {
  id: string;
  role: "assistant" | "user" | "system";
  content: string;
  isStreaming?: boolean;
  mode?: "ask" | "agent";
  agentState?: AgentMessageState;
}

interface AgentTimelineItem {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "failed";
  summary: string;
  detail?: string;
}

interface AgentMessageState {
  taskId?: string;
  status: "planning" | "previewing" | "executing" | "completed" | "failed";
  summary: string;
  result?: string;
  timeline: AgentTimelineItem[];
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

interface PaperExplainViewModel {
  summary: string;
  roleInPaper: string;
  keyPoints: string[];
  terms: { term: string; explanation: string }[];
  methodOrLogic: string;
  evidence: string;
  assumptionsOrLimits: string;
  plainExplanation: string;
  confidence: string;
}

export function ReaderWorkspace({
  currentProject,
  documents,
  currentDocument,
  onSelectDocument,
  bootstrapBlocks,
  paperAnalyzeTrigger
}: ReaderWorkspaceProps) {
  const queryClient = useQueryClient();
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [referencedBlockId, setReferencedBlockId] = useState<string | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [chatMode, setChatMode] = useState<"ask" | "agent">("ask");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [draggingMessageId, setDraggingMessageId] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);
  const [agentRunning, setAgentRunning] = useState(false);
  const [openDocumentIds, setOpenDocumentIds] = useState<string[]>(() =>
    currentDocument ? [currentDocument.documentId] : []
  );
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [editingBlockTitle, setEditingBlockTitle] = useState("");
  const [editingBlockContent, setEditingBlockContent] = useState("");
  const [paperExplainProgressByDocument, setPaperExplainProgressByDocument] = useState<Record<string, {
    total: number;
    completed: number;
    failed: number;
    running: number;
    active: boolean;
  }>>({});
  const [paperExplainStatusesByDocument, setPaperExplainStatusesByDocument] = useState<Record<string, Record<string, "idle" | "running" | "completed" | "failed">>>({});
  const [paperExplainOverridesByDocument, setPaperExplainOverridesByDocument] = useState<Record<string, Record<string, BlockExplanation>>>({});
  const currentRequestIdRef = useRef<string | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const chatBodyRef = useRef<HTMLDivElement | null>(null);
  const blockStackRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const documentBlocksRef = useRef<HTMLDivElement | null>(null);
  const handledPaperAnalyzeTriggerRef = useRef<number>(0);
  const dragCandidateRef = useRef<{
    messageId: string;
    host: HTMLDivElement;
    message: ChatMessage;
    payload: DragInsertPayload;
    allowLiveSelection: boolean;
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

  const paperExplanationsQuery = useQuery({
    queryKey: ["document-paper-explanations", currentDocument?.documentId],
    queryFn: async () => listDocumentBlockExplanations({
      documentId: currentDocument!.documentId,
      mode: "paper"
    }),
    enabled: Boolean(currentDocument?.documentId)
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
  const paperExplanationMap = useMemo(() => {
    const currentOverrides = currentDocument
      ? paperExplainOverridesByDocument[currentDocument.documentId] ?? {}
      : {};
    const merged = new Map<string, BlockExplanation>();
    for (const explanation of paperExplanationsQuery.data?.explanations ?? []) {
      if (!merged.has(explanation.blockId)) {
        merged.set(explanation.blockId, explanation);
      }
    }
    for (const [blockId, explanation] of Object.entries(currentOverrides)) {
      merged.set(blockId, explanation);
    }
    return merged;
  }, [currentDocument, paperExplanationsQuery.data?.explanations, paperExplainOverridesByDocument]);
  const currentPaperExplainProgress = currentDocument
    ? paperExplainProgressByDocument[currentDocument.documentId] ?? null
    : null;
  const currentPaperExplainStatuses = currentDocument
    ? paperExplainStatusesByDocument[currentDocument.documentId] ?? {}
    : {};

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
    if (paperAnalyzeTrigger <= handledPaperAnalyzeTriggerRef.current) {
      return;
    }
    handledPaperAnalyzeTriggerRef.current = paperAnalyzeTrigger;
    if (!currentDocument || blocks.length === 0) {
      return;
    }
    void runPaperExplainBatch(blocks);
  }, [blocks, currentDocument, paperAnalyzeTrigger]);

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

  useEffect(() => {
    const body = chatBodyRef.current;
    if (!body) {
      return;
    }

    const hasStreaming = chatMessages.some((message) => message.isStreaming)
      || chatMessages.some((message) => {
        const status = message.agentState?.status;
        return status === "planning" || status === "previewing" || status === "executing";
      });

    const scrollBehavior: ScrollBehavior = hasStreaming ? "smooth" : "auto";
    window.requestAnimationFrame(() => {
      body.scrollTo({
        top: body.scrollHeight,
        behavior: scrollBehavior
      });
      window.setTimeout(() => {
        body.scrollTo({
          top: body.scrollHeight,
          behavior: "auto"
        });
      }, 40);
    });
  }, [chatMessages]);

  function updateAgentMessage(messageId: string, updater: (current: AgentMessageState) => AgentMessageState) {
    setChatMessages((current) =>
      current.map((message) => {
        if (message.id !== messageId || !message.agentState) {
          return message;
        }

        return {
          ...message,
          agentState: updater(message.agentState)
        };
      })
    );
  }

  function pushAgentTimelineItem(messageId: string, item: AgentTimelineItem) {
    updateAgentMessage(messageId, (current) => ({
      ...current,
      timeline: [...current.timeline, item]
    }));
  }

  function replaceAgentTimelineItem(messageId: string, itemId: string, updater: (item: AgentTimelineItem) => AgentTimelineItem) {
    updateAgentMessage(messageId, (current) => ({
      ...current,
      timeline: current.timeline.map((item) => item.id === itemId ? updater(item) : item)
    }));
  }

  async function runPaperExplainBatch(targetBlocks: Block[]) {
    if (!currentDocument || targetBlocks.length === 0 || currentPaperExplainProgress?.active) {
      return;
    }
    const documentId = currentDocument.documentId;

    let completed = 0;
    let failed = 0;
    let running = 0;
    const total = targetBlocks.length;
    const queue = [...targetBlocks];
    const concurrency = Math.min(4, Math.max(1, queue.length));

    setPaperExplainOverridesByDocument((current) => ({
      ...current,
      [documentId]: {}
    }));
    setPaperExplainStatusesByDocument((current) => ({
      ...current,
      [documentId]: Object.fromEntries(targetBlocks.map((block) => [block.blockId, "idle" as const]))
    }));
    setPaperExplainProgressByDocument((current) => ({
      ...current,
      [documentId]: {
        total,
        completed: 0,
        failed: 0,
        running: 0,
        active: true
      }
    }));

    const syncProgress = () => {
      setPaperExplainProgressByDocument((current) => ({
        ...current,
        [documentId]: {
          total,
          completed,
          failed,
          running,
          active: completed + failed < total
        }
      }));
    };

    async function worker() {
      while (queue.length > 0) {
        const nextBlock = queue.shift();
        if (!nextBlock) {
          return;
        }

        running += 1;
        setPaperExplainStatusesByDocument((current) => ({
          ...current,
          [documentId]: {
            ...(current[documentId] ?? {}),
            [nextBlock.blockId]: "running"
          }
        }));
        syncProgress();

        try {
          const result = await explainBlock({
            blockId: nextBlock.blockId,
            mode: "paper"
          });
          completed += 1;
          setPaperExplainOverridesByDocument((current) => ({
            ...current,
            [documentId]: {
              ...(current[documentId] ?? {}),
              [nextBlock.blockId]: result.explanation
            }
          }));
          setPaperExplainStatusesByDocument((current) => ({
            ...current,
            [documentId]: {
              ...(current[documentId] ?? {}),
              [nextBlock.blockId]: "completed"
            }
          }));
        } catch {
          failed += 1;
          setPaperExplainStatusesByDocument((current) => ({
            ...current,
            [documentId]: {
              ...(current[documentId] ?? {}),
              [nextBlock.blockId]: "failed"
            }
          }));
        } finally {
          running -= 1;
          syncProgress();
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    await queryClient.invalidateQueries({ queryKey: ["document-paper-explanations", documentId] });
  }

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

  async function runAgentConversation(taskText: string) {
    if (!currentProject) {
      setChatMessages((current) => [
        ...current,
        {
          id: `system-${Date.now()}`,
          role: "system",
          content: "请先打开一个项目，再使用 Agent 模式。"
        }
      ]);
      return;
    }

    const messageId = `assistant-agent-${Date.now()}`;
    setAgentRunning(true);
    setChatMessages((current) => [
      ...current,
      {
        id: messageId,
        role: "assistant",
        content: "",
        mode: "agent",
        agentState: {
          status: "planning",
          summary: "正在理解任务并生成执行计划…",
          timeline: [
            {
              id: "plan",
              title: "分析任务",
              status: "running",
              summary: "正在结合当前项目内容生成可执行计划。"
            }
          ]
        }
      }
    ]);

    try {
      const planResult = await planAgentTask({
        projectId: currentProject.projectId,
        taskText
      });

      updateAgentMessage(messageId, (current) => ({
        ...current,
        taskId: planResult.task.taskId,
        status: "previewing",
        summary: `已生成计划，共 ${planResult.plan.steps.length} 步。正在生成预览…`
      }));

      replaceAgentTimelineItem(messageId, "plan", (item) => ({
        ...item,
        status: "completed",
        summary: `已生成 ${planResult.plan.steps.length} 个步骤。`,
        detail: planResult.plan.steps.map((step, index) => `${index + 1}. ${step.title}\n工具：${step.toolName}\n参数：${step.argumentsJson}`).join("\n\n")
      }));

      pushAgentTimelineItem(messageId, {
        id: "preview",
        title: "生成预览",
        status: "running",
        summary: "正在检查这次任务将影响哪些对象。"
      });

      const previewResult = await generateAgentPreview(planResult.task.taskId);
      replaceAgentTimelineItem(messageId, "preview", (item) => ({
        ...item,
        status: "completed",
        summary: previewResult.preview.summary,
        detail: previewResult.preview.items.map((entry, index) => `${index + 1}. ${entry.label}\n风险：${entry.riskLevel}\n前：${entry.beforeSummary ?? "无"}\n后：${entry.afterSummary ?? "无"}`).join("\n\n")
      }));

      pushAgentTimelineItem(messageId, {
        id: "execute",
        title: "执行任务",
        status: "running",
        summary: "正在调用本地白名单工具执行任务。"
      });

      updateAgentMessage(messageId, (current) => ({
        ...current,
        status: "executing",
        summary: "正在执行计划，滚动输出执行日志…"
      }));

      await confirmAgentTask(planResult.task.taskId);

      let finalAudit: GetAgentAuditOutput | null = null;
      for (let round = 0; round < 30; round += 1) {
        const audit = await getAgentAudit(planResult.task.taskId);
        finalAudit = audit;
        replaceAgentTimelineItem(messageId, "execute", (item) => ({
          ...item,
          status: audit.task.status === "failed" ? "failed" : audit.task.status === "completed" ? "completed" : "running",
          summary: buildAgentExecutionSummary(audit),
          detail: buildAgentExecutionDetail(audit)
        }));

        updateAgentMessage(messageId, (current) => ({
          ...current,
          status: audit.task.status === "failed" ? "failed" : audit.task.status === "completed" ? "completed" : "executing",
          summary: buildAgentExecutionSummary(audit),
          result: audit.task.status === "completed"
            ? buildAgentResultText(audit)
            : audit.task.status === "failed"
              ? buildAgentFailureText(audit)
              : current.result
        }));

        if (audit.task.status === "completed" || audit.task.status === "failed" || audit.task.status === "rolled_back" || audit.task.status === "cancelled") {
          break;
        }

        await sleep(600);
      }

      if (!finalAudit) {
        throw new Error("未能读取到 Agent 执行结果。");
      }

      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
      await queryClient.invalidateQueries({ queryKey: ["document-blocks", currentDocument?.documentId] });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent 执行失败";
      updateAgentMessage(messageId, (current) => ({
        ...current,
        status: "failed",
        summary: "任务执行失败。",
        result: message,
        timeline: current.timeline.map((item) =>
          item.status === "running"
            ? { ...item, status: "failed", summary: message }
            : item
        )
      }));
    } finally {
      setAgentRunning(false);
    }
  }

  function handleSelectBlock(block: Block) {
    setSelectedBlockId(block.blockId);
  }

  function handleStartEditBlock(block: Block) {
    setEditingBlockId(block.blockId);
    setEditingBlockTitle(block.title ?? "");
    setEditingBlockContent(block.contentMd);
  }

  function handleSendChat() {
    const nextQuestion = chatDraft.trim() || (referencedBlock ? "请直接解析这个知识块。" : "请直接回答用户问题。");
    setChatMessages((current) => [
      ...current,
      {
        id: `user-${Date.now()}`,
        role: "user",
        content: nextQuestion
      }
    ]);
    setChatDraft("");
    if (chatMode === "agent") {
      void runAgentConversation(nextQuestion);
      return;
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const nextHistory = chatMessages
      .filter((item) =>
        (item.role === "user" || item.role === "assistant")
        && item.mode !== "agent"
        && item.content.trim().length > 0
      )
      .slice(-6)
      .map((item) => ({ role: item.role as "user" | "assistant", content: item.content }));

    currentRequestIdRef.current = requestId;
    setChatMessages((current) => [
      ...current,
      {
        id: `assistant-${requestId}`,
        role: "assistant",
        content: "",
        isStreaming: true
      }
    ]);
    chatMutation.mutate({
      blockId: referencedBlock?.blockId,
      question: nextQuestion,
      requestId,
      history: nextHistory
    });
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

  function canStartSelectionDrag(host: HTMLDivElement, target: HTMLElement) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return false;
    }

    const selectedText = selection.toString().trim();
    if (!selectedText) {
      return false;
    }

    const anchorInside = host.contains(selection.anchorNode);
    const focusInside = host.contains(selection.focusNode);
    if (!anchorInside || !focusInside) {
      return false;
    }

    const range = selection.getRangeAt(0);
    const commonAncestor = range.commonAncestorContainer;
    return target.contains(commonAncestor) || target.contains(selection.anchorNode) || target.contains(selection.focusNode);
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
  function handleAssistantBlockDragMouseDown(event: React.MouseEvent<HTMLButtonElement>, message: ChatMessage) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const host = event.currentTarget.closest(".chat-message-card") as HTMLDivElement | null;
    if (!host) {
      return;
    }
    const initialPayload = {
      contentMd: message.content,
      title: (message.content.split("\n").find((line) => line.trim()) ?? "AI 笔记").replace(/^#+\s*/, "").trim().slice(0, 36) || "AI 笔记",
      sourceKind: "block" as const
    };
    document.body.classList.add("is-note-drag-pending");
    window.getSelection()?.removeAllRanges();

    dragPointerRef.current = { x: event.clientX, y: event.clientY };
    dragCandidateRef.current = {
      messageId: message.id,
      host,
      message,
      payload: initialPayload,
      allowLiveSelection: false,
      startX: event.clientX,
      startY: event.clientY
    };
  }

  function handleAssistantSelectionMouseDown(event: React.MouseEvent<HTMLDivElement>, message: ChatMessage) {
    if (event.button !== 0) {
      return;
    }

    const host = event.currentTarget.closest(".chat-message-card") as HTMLDivElement | null;
    if (!host) {
      return;
    }

    const target = event.target as HTMLElement;
    if (!canStartSelectionDrag(host, target)) {
      return;
    }

    const initialPayload = buildDragPayload(host, message);
    if (initialPayload.sourceKind !== "selection") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    dragPointerRef.current = { x: event.clientX, y: event.clientY };
    dragCandidateRef.current = {
      messageId: message.id,
      host,
      message,
      payload: initialPayload,
      allowLiveSelection: false,
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
                    {currentPaperExplainProgress ? (
                      <div className="paper-analysis-progress">
                        <div className="paper-analysis-progress-header">
                          <span>全文论文解析</span>
                          <span>
                            {currentPaperExplainProgress.completed + currentPaperExplainProgress.failed}/{currentPaperExplainProgress.total}
                          </span>
                        </div>
                        <div className="paper-analysis-progress-bar">
                          <div
                            className="paper-analysis-progress-bar-fill"
                            style={{
                              width: `${currentPaperExplainProgress.total === 0
                                ? 0
                                : Math.round(((currentPaperExplainProgress.completed + currentPaperExplainProgress.failed) / currentPaperExplainProgress.total) * 100)}%`
                            }}
                          />
                        </div>
                        <div className="paper-analysis-progress-meta">
                          <span>已完成 {currentPaperExplainProgress.completed}</span>
                          <span>解析中 {currentPaperExplainProgress.running}</span>
                          <span>失败 {currentPaperExplainProgress.failed}</span>
                        </div>
                      </div>
                    ) : null}
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
                            <>
                              <MarkdownArticle content={block.contentMd} />
                              <PaperExplainPanel
                                explanation={paperExplanationMap.get(block.blockId) ?? null}
                                status={currentPaperExplainStatuses[block.blockId] ?? "idle"}
                              />
                            </>
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

        <div className="chat-pane-body" ref={chatBodyRef}>
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
                onDragEnd={() => {
                  setDropIndex(null);
                  setDraggingMessageId(null);
                }}
              >
                <div className="chat-message-head">
                  <div className="chat-message-role">{message.role === "assistant" ? "AI" : "你"}</div>
                  {message.role === "assistant" ? (
                    <button
                      className="chat-message-drag-handle"
                      onMouseDown={(event) => handleAssistantBlockDragMouseDown(event, message)}
                      aria-label="拖动整块回复"
                      title="拖动整块回复"
                    >
                      <SvgGripIcon />
                    </button>
                  ) : null}
                </div>
                <div
                  onDragStart={(event) => {
                    event.preventDefault();
                  }}
                  className={
                    message.isStreaming
                      ? "chat-message-content chat-message-content-streaming"
                      : "chat-message-content"
                  }
                  onMouseDown={(event) => {
                    if (message.role !== "assistant") {
                      return;
                    }
                    handleAssistantSelectionMouseDown(event, message);
                  }}
                >
                  {message.mode === "agent" && message.agentState ? (
                    <div className="agent-chat-card">
                      <div
                        className={
                          message.agentState.status === "planning" || message.agentState.status === "previewing" || message.agentState.status === "executing"
                            ? "agent-chat-summary agent-chat-summary-thinking"
                            : "agent-chat-summary"
                        }
                      >
                        {message.agentState.summary}
                      </div>
                      <div className="agent-chat-timeline">
                        {message.agentState.timeline.map((item) => (
                          <details key={item.id} className={`agent-chat-step agent-chat-step-${item.status}`}>
                            <summary className="agent-chat-step-summary">
                              <span className="agent-chat-step-title">{item.title}</span>
                              <span className="agent-chat-step-status">{renderAgentStepStatus(item.status)}</span>
                            </summary>
                            <div className="agent-chat-step-body">
                              <div>{item.summary}</div>
                              {item.detail ? <pre className="agent-chat-step-detail">{item.detail}</pre> : null}
                            </div>
                          </details>
                        ))}
                      </div>
                      {message.agentState.result ? (
                        <div className="agent-chat-result">
                          <div className="agent-chat-result-title">结果</div>
                          <MarkdownArticle content={message.agentState.result} className="markdown-article-chat" />
                        </div>
                      ) : null}
                    </div>
                  ) : message.role === "assistant" ? (
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
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) {
                return;
              }
              event.preventDefault();
              handleSendChat();
            }}
            placeholder={chatMode === "agent" ? "输入要 Agent 执行的自然语言任务" : "输入问题"}
          />
          <div className="chat-input-footer">
            <div className="chat-mode-switch">
              <button
                className={chatMode === "ask" ? "chat-mode-button chat-mode-button-active" : "chat-mode-button"}
                onClick={() => setChatMode("ask")}
              >
                Ask
              </button>
              <button
                className={chatMode === "agent" ? "chat-mode-button chat-mode-button-active" : "chat-mode-button"}
                onClick={() => setChatMode("agent")}
              >
                Agent
              </button>
            </div>
            <button
              className="send-button"
              disabled={chatMutation.isPending || agentRunning}
              onClick={handleSendChat}
            >
              {agentRunning ? "执行中" : "发送"}
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

function renderAgentStepStatus(status: AgentTimelineItem["status"]) {
  switch (status) {
    case "running":
      return "进行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    default:
      return "待执行";
  }
}

function buildAgentExecutionSummary(audit: GetAgentAuditOutput) {
  const lastLog = audit.logs.at(-1);
  if (audit.task.status === "completed") {
    return "任务执行完成。";
  }
  if (audit.task.status === "failed") {
    return lastLog?.message ?? "任务执行失败。";
  }
  return lastLog?.message ?? "正在执行任务。";
}

function buildAgentExecutionDetail(audit: GetAgentAuditOutput) {
  return audit.logs
    .slice(-12)
    .map((log) => `[${new Date(log.createdAt).toLocaleTimeString()}] ${log.level.toUpperCase()} ${log.message}`)
    .join("\n");
}

function buildAgentResultText(audit: GetAgentAuditOutput) {
  const actions = summarizeAgentFileActions(audit);
  if (actions.length === 1) {
    return `你的任务已经完成。${actions[0]}。如果还需要我继续处理别的资料，可以直接告诉我。`;
  }
  if (actions.length > 1) {
    return `你的任务已经完成。我这次做了这些操作：\n${actions.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\n如果还需要我继续处理别的资料，可以直接告诉我。`;
  }
  const lastInfo = [...audit.logs].reverse().find((log) => log.level === "info");
  return `你的任务已经完成。${lastInfo?.message ?? "这次没有需要额外说明的文件变更。"} 如果还需要我继续处理别的资料，可以直接告诉我。`;
}

function buildAgentFailureText(audit: GetAgentAuditOutput) {
  const lastError = [...audit.logs].reverse().find((log) => log.level === "error");
  return lastError?.message ?? "任务执行失败。";
}

function PaperExplainPanel({
  explanation,
  status
}: {
  explanation: BlockExplanation | null;
  status: "idle" | "running" | "completed" | "failed";
}) {
  if (!explanation && status === "idle") {
    return null;
  }

  if (!explanation && status === "running") {
    return (
      <div className="paper-explain-panel paper-explain-panel-pending">
        <div className="paper-explain-header">
          <span className="paper-explain-title">论文解析</span>
          <span className="paper-explain-status">解析中</span>
        </div>
        <div className="paper-explain-shimmer" />
      </div>
    );
  }

  if (!explanation && status === "failed") {
    return (
      <div className="paper-explain-panel paper-explain-panel-failed">
        <div className="paper-explain-header">
          <span className="paper-explain-title">论文解析</span>
          <span className="paper-explain-status">失败</span>
        </div>
        <div className="paper-explain-text">当前块解析失败，你可以再次触发全文解析。</div>
      </div>
    );
  }

  if (!explanation) {
    return null;
  }

  const parsed = parsePaperExplanation(explanation);
  return (
    <div className="paper-explain-panel">
      <div className="paper-explain-header">
        <span className="paper-explain-title">论文解析</span>
        <span className="paper-explain-status">{formatPaperConfidence(parsed.confidence)}</span>
      </div>
      <div className="paper-explain-section">
        <div className="paper-explain-label">核心解读</div>
        <div className="paper-explain-text">{parsed.summary}</div>
      </div>
      <div className="paper-explain-section-grid">
        <div className="paper-explain-section">
          <div className="paper-explain-label">在论文中的作用</div>
          <div className="paper-explain-text">{parsed.roleInPaper}</div>
        </div>
        <div className="paper-explain-section">
          <div className="paper-explain-label">白话解释</div>
          <div className="paper-explain-text">{parsed.plainExplanation}</div>
        </div>
      </div>
      {parsed.keyPoints.length > 0 ? (
        <div className="paper-explain-section">
          <div className="paper-explain-label">关键要点</div>
          <ul className="paper-explain-list">
            {parsed.keyPoints.map((item, index) => (
              <li key={`${index}-${item}`}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {parsed.terms.length > 0 ? (
        <div className="paper-explain-section">
          <div className="paper-explain-label">术语解释</div>
          <div className="paper-explain-terms">
            {parsed.terms.map((item, index) => (
              <div key={`${item.term}-${index}`} className="paper-explain-term">
                <div className="paper-explain-term-name">{item.term}</div>
                <div className="paper-explain-term-text">{item.explanation}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="paper-explain-section-grid">
        <div className="paper-explain-section">
          <div className="paper-explain-label">方法或逻辑</div>
          <div className="paper-explain-text">{parsed.methodOrLogic}</div>
        </div>
        <div className="paper-explain-section">
          <div className="paper-explain-label">证据或现象</div>
          <div className="paper-explain-text">{parsed.evidence}</div>
        </div>
      </div>
      <div className="paper-explain-section">
        <div className="paper-explain-label">假设与限制</div>
        <div className="paper-explain-text">{parsed.assumptionsOrLimits}</div>
      </div>
    </div>
  );
}

function summarizeAgentFileActions(audit: GetAgentAuditOutput) {
  const taskText = audit.task.taskText;
  const actionLines: string[] = [];

  for (const snapshot of audit.snapshots) {
    const filePath = snapshot.filePath;
    if (!filePath) {
      continue;
    }

    const snapshotPayload = safeParseJson(snapshot.snapshotJson);
    const existsBefore = snapshotPayload?.existsBefore;
    const readablePath = formatAgentDisplayPath(filePath);

    if ((taskText.includes("删除") || taskText.includes("移除")) && existsBefore === true) {
      actionLines.push(`删除了文件 ${readablePath}`);
      continue;
    }

    if ((taskText.includes("新建") || taskText.includes("创建") || taskText.includes("生成")) && existsBefore === false) {
      actionLines.push(`新增了文件 ${readablePath}`);
      continue;
    }

    if (existsBefore === false) {
      actionLines.push(`新增了文件 ${readablePath}`);
      continue;
    }

    actionLines.push(`更新了文件 ${readablePath}`);
  }

  return [...new Set(actionLines)].slice(0, 8);
}

function formatAgentDisplayPath(input: string) {
  const normalized = input
    .replace(/^\/\?\//, "")
    .replace(/^\\\\\?\\/, "")
    .replaceAll("\\", "/");

  const projectMatch = normalized.match(/\/projects\/[^/]+\/(.+)$/i);
  if (projectMatch?.[1]) {
    return projectMatch[1];
  }

  const sourceMatch = normalized.match(/\/(source|normalized|blocks|notes|exports)\/.+$/i);
  if (sourceMatch) {
    return normalized.slice(sourceMatch.index! + 1);
  }

  return normalized;
}

function safeParseJson(input: string) {
  try {
    return JSON.parse(input) as { existsBefore?: boolean };
  } catch {
    return null;
  }
}

function parsePaperExplanation(explanation: BlockExplanation): PaperExplainViewModel {
  const parsed = safeParsePaperJson(explanation.rawResponseJson);
  const parsedContent = parsed?.parsed_content ?? null;
  return {
    summary:
      parsed?.summary
      ?? readPaperString(parsedContent, ["what_is_this_block_about", "当前块主题", "说明当前块到底在讲什么", "当前块内容概述"])
      ?? explanation.summary
      ?? "当前块已完成解析。",
    roleInPaper:
      parsed?.roleInPaper
      ?? readPaperString(parsedContent, ["role_in_paper", "在论文中的作用", "在论文整体中的作用"])
      ?? explanation.roleInDocument
      ?? "当前块未提供充分信息",
    keyPoints:
      parsed?.keyPoints
      ?? readPaperStringArray(parsedContent, ["key_points", "最重要要点", "最重要的要点"])
      ?? [],
    terms:
      parsed?.terms
      ?? readPaperTerms(parsedContent, ["terms", "key_terms", "关键术语解释"])
      ?? [],
    methodOrLogic:
      parsed?.methodOrLogic
      ?? readPaperString(parsedContent, ["method_or_logic", "core_logic_if_method", "core_logic_if_method_or_experiment", "core_logic_if_applicable", "核心逻辑", "核心逻辑或证据"])
      ?? "当前块未提供充分信息",
    evidence:
      parsed?.evidence
      ?? readPaperString(parsedContent, ["evidence", "evidence_if_applicable", "evidence_if_results", "evidence_if_results_or_observations", "证据或结果", "证据或现象"])
      ?? "当前块未提供充分信息",
    assumptionsOrLimits:
      parsed?.assumptionsOrLimits
      ?? readPaperString(parsedContent, ["assumptions_or_limits", "assumptions_limitations", "assumptions_limitations_boundaries", "assumptions_limitations_if_applicable", "假设、限制或边界条件"])
      ?? "当前块未体现",
    plainExplanation:
      parsed?.plainExplanation
      ?? readPaperString(parsedContent, ["plain_language_explanation", "plain_explanation", "直白解释"])
      ?? parsed?.summary
      ?? readPaperString(parsedContent, ["what_is_this_block_about", "当前块主题", "说明当前块到底在讲什么", "当前块内容概述"])
      ?? explanation.summary,
    confidence: parsed?.confidence ?? "medium"
  };
}

function safeParsePaperJson(input: string) {
  try {
    return JSON.parse(input) as {
      summary?: string;
      roleInPaper?: string;
      keyPoints?: string[];
      terms?: { term: string; explanation: string }[];
      methodOrLogic?: string;
      evidence?: string;
      assumptionsOrLimits?: string;
      plainExplanation?: string;
      confidence?: string;
      parsed_content?: Record<string, unknown>;
    };
  } catch {
    return null;
  }
}

function normalizeKeyPointsFromText(value: unknown) {
  if (!value || typeof value !== "string") {
    return null;
  }
  const items = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^[\d.\-•\s]+/, "").trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

function readPaperString(
  source: Record<string, unknown> | null | undefined,
  keys: string[]
) {
  if (!source) {
    return null;
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function readPaperStringArray(
  source: Record<string, unknown> | null | undefined,
  keys: string[]
) {
  if (!source) {
    return null;
  }
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      const items = value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
      if (items.length > 0) {
        return items;
      }
    }
    const normalized = normalizeKeyPointsFromText(value);
    if (normalized && normalized.length > 0) {
      return normalized;
    }
  }
  return null;
}

function readPaperTerms(
  source: Record<string, unknown> | null | undefined,
  keys: string[]
) {
  if (!source) {
    return null;
  }
  for (const key of keys) {
    const value = source[key];
    const normalized = normalizeTermsFromUnknown(value);
    if (normalized && normalized.length > 0) {
      return normalized;
    }
  }
  return null;
}

function normalizeTermsFromUnknown(value: unknown) {
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    const items = value
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const term = typeof (entry as { term?: unknown }).term === "string" ? (entry as { term: string }).term : "";
        const explanation = typeof (entry as { explanation?: unknown }).explanation === "string" ? (entry as { explanation: string }).explanation : "";
        return term ? { term, explanation } : null;
      })
      .filter((item): item is { term: string; explanation: string } => Boolean(item));
    return items.length > 0 ? items : null;
  }
  if (typeof value === "object") {
    const items = Object.entries(value as Record<string, unknown>)
      .map(([term, explanation]) => ({
        term,
        explanation: typeof explanation === "string" ? explanation : ""
      }))
      .filter((item) => item.term.trim().length > 0);
    return items.length > 0 ? items : null;
  }
  if (typeof value === "string") {
    const items = value
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^[\d.\-•\s]+/, "").trim())
      .filter(Boolean)
      .map((line) => {
        const [term, explanation = ""] = line.split(/：|:/, 2);
        return {
          term: term.trim(),
          explanation: explanation.trim()
        };
      })
      .filter((item) => item.term.length > 0);
    return items.length > 0 ? items : null;
  }
  return null;
}

function formatPaperConfidence(confidence: string) {
  if (confidence === "high") {
    return "高可信";
  }
  if (confidence === "low") {
    return "低可信";
  }
  return "中可信";
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
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

function SvgGripIcon() {
  return (
    <svg className="inline-action-icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="5" cy="4.5" r="0.9" />
      <circle cx="11" cy="4.5" r="0.9" />
      <circle cx="5" cy="8" r="0.9" />
      <circle cx="11" cy="8" r="0.9" />
      <circle cx="5" cy="11.5" r="0.9" />
      <circle cx="11" cy="11.5" r="0.9" />
    </svg>
  );
}
