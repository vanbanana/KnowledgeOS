import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Util } from "pdfjs-dist";
import type { Block, BlockExplanation, Document, Project } from "@knowledgeos/shared-types";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  PdfHighlighter,
  PdfLoader,
  TextHighlight,
  useHighlightContainerContext
} from "react-pdf-highlighter-extended";
import type { Highlight, PdfHighlighterUtils, PdfSelection } from "react-pdf-highlighter-extended";
import { listBlocks } from "../lib/commands/client";
import { MarkdownArticle } from "./MarkdownArticle";

interface PdfReaderWorkspaceProps {
  currentProject: Project | null;
  documents: Document[];
  currentDocument: Document | null;
  bootstrapBlocks: Block[];
}

interface DocumentPdfBytesResponse {
  base64Data: string;
  byteLen: number;
}

type ExplainRunStatus = "idle" | "running" | "completed" | "failed";

interface SelectionExplainTerm {
  term: string;
  explanation: string;
}

interface SelectionPaperExplainResponse {
  summary: string;
  plainExplanation: string;
  keyPoints: string[];
  prerequisites: string[];
  pitfalls: string[];
  examples: string[];
  terms: SelectionExplainTerm[];
  extension: string[];
  confidence: string;
  rawJson: string;
  model: string;
  provider: string;
}

interface SelectionExplainStreamEventPayload {
  requestId: string;
  chunk: string;
  done: boolean;
  error?: string | null;
}

const PDF_MANUAL_HIGHLIGHT_STORAGE_PREFIX = "knowflow:pdf:manual-highlights:v1";
const PDF_SELECTION_EXPLAIN_STORAGE_PREFIX = "knowflow:pdf:selection-explain:v1";
const manualHighlightMemoryStore = new Map<string, PersistedManualHighlightState>();
const selectionExplainMemoryStore = new Map<string, Record<string, SelectionPaperExplainResponse>>();

interface PersistedManualHighlightState {
  highlights: ViewerHighlight[];
  selectedBlockId: string | null;
}

function buildManualHighlightStorageKey(documentId: string) {
  return `${PDF_MANUAL_HIGHLIGHT_STORAGE_PREFIX}:${documentId}`;
}

function readPersistedManualHighlightState(documentId: string): PersistedManualHighlightState {
  const memory = manualHighlightMemoryStore.get(documentId);
  if (memory) {
    return memory;
  }
  try {
    const raw = window.localStorage.getItem(buildManualHighlightStorageKey(documentId));
    if (!raw) {
      return { highlights: [], selectedBlockId: null };
    }
    const parsed = JSON.parse(raw) as { highlights?: unknown; selectedBlockId?: unknown };
    const highlights = Array.isArray(parsed.highlights)
      ? parsed.highlights.filter((item): item is ViewerHighlight => {
        if (!item || typeof item !== "object") {
          return false;
        }
        const id = (item as { id?: unknown }).id;
        const position = (item as { position?: unknown }).position;
        return typeof id === "string" && id.startsWith("manual-") && Boolean(position);
      })
      : [];
    const selectedBlockId = typeof parsed.selectedBlockId === "string" ? parsed.selectedBlockId : null;
    return { highlights, selectedBlockId };
  } catch {
    return { highlights: [], selectedBlockId: null };
  }
}

function writePersistedManualHighlightState(documentId: string, state: PersistedManualHighlightState) {
  manualHighlightMemoryStore.set(documentId, state);
  try {
    window.localStorage.setItem(buildManualHighlightStorageKey(documentId), JSON.stringify(state));
  } catch {
    // 本地存储失败时静默降级，不影响阅读流程
  }
}

function buildSelectionExplainStorageKey(documentId: string) {
  return `${PDF_SELECTION_EXPLAIN_STORAGE_PREFIX}:${documentId}`;
}

function readPersistedSelectionExplainState(documentId: string) {
  const memory = selectionExplainMemoryStore.get(documentId);
  if (memory) {
    return memory;
  }
  try {
    const raw = window.localStorage.getItem(buildSelectionExplainStorageKey(documentId));
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const normalized: Record<string, SelectionPaperExplainResponse> = {};
    for (const [highlightId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!highlightId.startsWith("manual-") || !value || typeof value !== "object") {
        continue;
      }
      const item = value as Partial<SelectionPaperExplainResponse>;
      if (typeof item.summary !== "string" || typeof item.plainExplanation !== "string") {
        continue;
      }
      normalized[highlightId] = {
        summary: item.summary,
        plainExplanation: item.plainExplanation,
        keyPoints: Array.isArray(item.keyPoints) ? item.keyPoints.filter((entry): entry is string => typeof entry === "string") : [],
        prerequisites: Array.isArray(item.prerequisites) ? item.prerequisites.filter((entry): entry is string => typeof entry === "string") : [],
        pitfalls: Array.isArray(item.pitfalls) ? item.pitfalls.filter((entry): entry is string => typeof entry === "string") : [],
        examples: Array.isArray(item.examples) ? item.examples.filter((entry): entry is string => typeof entry === "string") : [],
        terms: normalizeSelectionExplainTerms(item.terms),
        extension: Array.isArray(item.extension) ? item.extension.filter((entry): entry is string => typeof entry === "string") : [],
        confidence: typeof item.confidence === "string" ? item.confidence : "medium",
        rawJson: typeof item.rawJson === "string" ? item.rawJson : "",
        model: typeof item.model === "string" ? item.model : "",
        provider: typeof item.provider === "string" ? item.provider : ""
      };
    }
    return normalized;
  } catch {
    return {};
  }
}

function writePersistedSelectionExplainState(documentId: string, state: Record<string, SelectionPaperExplainResponse>) {
  selectionExplainMemoryStore.set(documentId, state);
  try {
    window.localStorage.setItem(buildSelectionExplainStorageKey(documentId), JSON.stringify(state));
  } catch {
    // 本地存储失败时静默降级
  }
}

export function PdfReaderWorkspace({
  currentProject,
  documents,
  currentDocument,
  bootstrapBlocks
}: PdfReaderWorkspaceProps) {
  const pdfViewportRef = useRef<HTMLDivElement | null>(null);
  const highlighterUtilsRef = useRef<PdfHighlighterUtils | null>(null);
  const highlighterShellRef = useRef<HTMLDivElement | null>(null);

  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [viewerHighlights, setViewerHighlights] = useState<ViewerHighlight[]>([]);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [pdfState, setPdfState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [pdfMessage, setPdfMessage] = useState<string | null>(null);
  const boxSelectMode = true;
  const [selectionExplainByHighlightId, setSelectionExplainByHighlightId] = useState<Record<string, SelectionPaperExplainResponse>>({});
  const [selectionExplainStatusByHighlightId, setSelectionExplainStatusByHighlightId] = useState<Record<string, ExplainRunStatus>>({});
  const [selectionExplainStreamByHighlightId, setSelectionExplainStreamByHighlightId] = useState<Record<string, string>>({});
  const [collapsedByHighlightId, setCollapsedByHighlightId] = useState<Record<string, boolean>>({});
  const selectionExplainingIdsRef = useRef<Set<string>>(new Set());
  const selectionExplainChunkBufferRef = useRef<Record<string, string>>({});
  const selectionExplainChunkFlushTimerRef = useRef<number | null>(null);
  const [hydratedDocumentId, setHydratedDocumentId] = useState<string | null>(null);
  const [highlighterShellWidth, setHighlighterShellWidth] = useState(0);
  const [pdfViewportWidth, setPdfViewportWidth] = useState(0);
  const currentDocumentId = currentDocument?.documentId ?? null;

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
  const blockLookup = useMemo(() => {
    const map = new Map<string, { title: string; snippet: string }>();
    for (const block of blocks) {
      map.set(block.blockId, {
        title: block.title?.trim() || `第 ${block.orderIndex + 1} 块`,
        snippet: toPlainText(block.contentMd).slice(0, 72) || "（无内容）"
      });
    }
    return map;
  }, [blocks]);
  const pdfDocumentConfig = useMemo(() => {
    if (!pdfData) {
      return null;
    }
    return {
      data: pdfData,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      useSystemFonts: true,
      disableFontFace: false
    };
  }, [pdfData]);
  const manualCalloutLayoutByHighlightId = useMemo(() => {
    const manualHighlights = viewerHighlights.filter((item) => item.id.startsWith("manual-"));
    if (manualHighlights.length === 0) {
      return {};
    }
    const groupedByPage = new Map<number, ViewerHighlight[]>();
    for (const item of manualHighlights) {
      const pageNumber = getHighlightPageNumber(item);
      const current = groupedByPage.get(pageNumber) ?? [];
      current.push(item);
      groupedByPage.set(pageNumber, current);
    }
    const nextLayout: Record<string, { top: number; height: number }> = {};
    for (const [, pageHighlights] of groupedByPage) {
      const pageLayout = buildManualCalloutLayoutForPage(
        pageHighlights,
        collapsedByHighlightId,
        selectionExplainByHighlightId,
        selectionExplainStatusByHighlightId
      );
      for (const [highlightId, item] of Object.entries(pageLayout)) {
        nextLayout[highlightId] = item;
      }
    }
    return nextLayout;
  }, [
    collapsedByHighlightId,
    selectionExplainByHighlightId,
    selectionExplainStatusByHighlightId,
    viewerHighlights
  ]);
  const calloutCardWidth = useMemo(() => {
    const baseWidth = highlighterShellWidth || pdfViewportWidth;
    if (!baseWidth) {
      return 300;
    }
    const widthRatio = baseWidth < 980 ? 0.3 : 0.24;
    return clampValue(Math.floor(baseWidth * widthRatio), 240, 420);
  }, [highlighterShellWidth, pdfViewportWidth]);
  const pdfRightReservedSpace = useMemo(() => {
    const baseWidth = highlighterShellWidth || pdfViewportWidth;
    const laneGap = baseWidth > 0 && baseWidth < 980 ? 72 : 88;
    return clampValue(calloutCardWidth + laneGap, 320, 620);
  }, [calloutCardWidth, highlighterShellWidth, pdfViewportWidth]);

  useEffect(() => {
    const shell = highlighterShellRef.current;
    if (!shell) {
      return;
    }
    const syncSize = () => {
      setHighlighterShellWidth(shell.clientWidth || 0);
    };
    syncSize();
    const observer = new ResizeObserver(() => {
      syncSize();
    });
    observer.observe(shell);
    return () => {
      observer.disconnect();
    };
  }, [pdfState, currentDocumentId]);

  useEffect(() => {
    const viewport = pdfViewportRef.current;
    if (!viewport) {
      return;
    }
    const syncSize = () => {
      setPdfViewportWidth(viewport.clientWidth || 0);
    };
    syncSize();
    const observer = new ResizeObserver(() => {
      syncSize();
    });
    observer.observe(viewport);
    return () => {
      observer.disconnect();
    };
  }, [pdfState, currentDocumentId]);

  useEffect(() => {
    const hasSelectedHighlight = viewerHighlights.some(
      (item) => item.blockId === selectedBlockId || item.id === selectedBlockId
    );
    if (viewerHighlights.length > 0) {
      if (!selectedBlockId || !hasSelectedHighlight) {
        const first = viewerHighlights[0];
        setSelectedBlockId(first?.blockId ?? first?.id ?? null);
      }
      return;
    }
    if (selectedBlockId) {
      setSelectedBlockId(null);
    }
  }, [selectedBlockId, viewerHighlights]);

  useEffect(() => {
    setHydratedDocumentId(null);
    setSelectionExplainByHighlightId({});
    setSelectionExplainStatusByHighlightId({});
    setSelectionExplainStreamByHighlightId({});
    setCollapsedByHighlightId({});
    selectionExplainingIdsRef.current.clear();
    setPdfData(null);
    setPdfState("idle");
    setPdfMessage(null);
    highlighterUtilsRef.current = null;

    if (!currentDocumentId) {
      setViewerHighlights([]);
      setSelectedBlockId(null);
      return;
    }
    const persisted = readPersistedManualHighlightState(currentDocumentId);
    const persistedSelectionExplain = readPersistedSelectionExplainState(currentDocumentId);
    setViewerHighlights(persisted.highlights);
    setSelectionExplainByHighlightId(persistedSelectionExplain);
    setSelectedBlockId(
      persisted.selectedBlockId
      ?? persisted.highlights[0]?.blockId
      ?? persisted.highlights[0]?.id
      ?? null
    );
    setHydratedDocumentId(currentDocumentId);
  }, [currentDocumentId]);

  useEffect(() => {
    if (!currentDocumentId || hydratedDocumentId !== currentDocumentId) {
      return;
    }
    const manualHighlights = viewerHighlights
      .filter((item) => item.id.startsWith("manual-"))
      .slice(-40);
    const selectedInManual = selectedBlockId && manualHighlights.some(
      (item) => item.blockId === selectedBlockId || item.id === selectedBlockId
    )
      ? selectedBlockId
      : null;
    writePersistedManualHighlightState(currentDocumentId, {
      highlights: manualHighlights,
      selectedBlockId: selectedInManual
    });
    const filteredSelectionExplain = Object.fromEntries(
      Object.entries(selectionExplainByHighlightId).filter(([highlightId]) =>
        manualHighlights.some((item) => item.id === highlightId)
      )
    );
    writePersistedSelectionExplainState(currentDocumentId, filteredSelectionExplain);
  }, [currentDocumentId, hydratedDocumentId, selectedBlockId, selectionExplainByHighlightId, viewerHighlights]);

  useEffect(() => {
    if (!currentDocumentId) {
      return;
    }
    let unlisten: (() => void) | null = null;
    const flushBufferedChunks = () => {
      selectionExplainChunkFlushTimerRef.current = null;
      const buffered = selectionExplainChunkBufferRef.current;
      const entries = Object.entries(buffered).filter(([, chunk]) => chunk.length > 0);
      if (entries.length === 0) {
        return;
      }
      selectionExplainChunkBufferRef.current = {};
      setSelectionExplainStreamByHighlightId((current) => {
        const next = { ...current };
        for (const [requestId, chunk] of entries) {
          next[requestId] = `${next[requestId] ?? ""}${chunk}`;
        }
        return next;
      });
    };
    const scheduleChunkFlush = () => {
      if (selectionExplainChunkFlushTimerRef.current !== null) {
        return;
      }
      selectionExplainChunkFlushTimerRef.current = window.setTimeout(flushBufferedChunks, 24);
    };
    const flushRequestChunk = (requestId: string) => {
      const chunk = selectionExplainChunkBufferRef.current[requestId];
      if (!chunk) {
        return;
      }
      delete selectionExplainChunkBufferRef.current[requestId];
      setSelectionExplainStreamByHighlightId((current) => ({
        ...current,
        [requestId]: `${current[requestId] ?? ""}${chunk}`
      }));
    };
    void listen<SelectionExplainStreamEventPayload>("reader-selection-explain-stream", (event) => {
      const payload = event.payload;
      const requestId = payload.requestId;
      if (!requestId || !requestId.startsWith("manual-")) {
        return;
      }
      if (payload.chunk) {
        selectionExplainChunkBufferRef.current[requestId] = `${selectionExplainChunkBufferRef.current[requestId] ?? ""}${payload.chunk}`;
        scheduleChunkFlush();
      }
      if (payload.error) {
        flushRequestChunk(requestId);
        setSelectionExplainStatusByHighlightId((current) => ({
          ...current,
          [requestId]: "failed"
        }));
      }
      if (payload.done) {
        flushRequestChunk(requestId);
        setSelectionExplainStatusByHighlightId((current) => {
          if (current[requestId] === "failed") {
            return current;
          }
          return {
            ...current,
            [requestId]: "completed"
          };
        });
      }
    }).then((fn) => {
      unlisten = fn;
    }).catch(() => {
      // 监听失败时静默处理，界面仍能显示最终解析结果
    });
    return () => {
      if (selectionExplainChunkFlushTimerRef.current !== null) {
        window.clearTimeout(selectionExplainChunkFlushTimerRef.current);
        selectionExplainChunkFlushTimerRef.current = null;
      }
      selectionExplainChunkBufferRef.current = {};
      if (unlisten) {
        unlisten();
      }
    };
  }, [currentDocumentId]);

  useEffect(() => {
    let disposed = false;
    async function loadPdfBytes() {
      if (!currentDocument || currentDocument.sourceType !== "pdf") {
        setPdfState("failed");
        setPdfMessage("当前文档不是 PDF。");
        return;
      }
      setPdfState("loading");
      setPdfMessage("正在读取 PDF 文件…");
      try {
        const payload = await invoke<DocumentPdfBytesResponse>(
          "get_document_pdf_bytes_command",
          { payload: { documentId: currentDocument.documentId } }
        );
        if (disposed) {
          return;
        }
        if (payload.byteLen <= 0) {
          throw new Error("PDF 文件为空");
        }
        setPdfData(decodeBase64ToUint8Array(payload.base64Data));
        setPdfState("ready");
        setPdfMessage(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : "未知错误";
        setPdfState("failed");
        setPdfMessage(`PDF 读取失败：${message}`);
      }
    }

    void loadPdfBytes();
    return () => {
      disposed = true;
    };
  }, [currentDocument?.documentId, currentDocument?.sourceType]);

  function handleSelectBlock(blockId: string) {
    setSelectedBlockId(blockId);
    const targetHighlight = viewerHighlights.find((item) => item.blockId === blockId || item.id === blockId);
    if (targetHighlight) {
      highlighterUtilsRef.current?.scrollToHighlight(targetHighlight);
    }
  }

  function handlePdfSelection(selection: PdfSelection) {
    const selectedText = selection.content.text?.trim() ?? "";
    if (!selectedText) {
      return;
    }
    const manualId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const nextHighlight: ViewerHighlight = {
      id: manualId,
      type: "text",
      position: selection.position,
      content: {
        text: selectedText
      },
      label: "学习解析",
      snippet: selectedText.slice(0, 60),
      detail: selectedText
    };
    setViewerHighlights((current) => {
      const manualOnly = current.filter((item) => item.id.startsWith("manual-"));
      return [...manualOnly, nextHighlight].slice(-12);
    });
    setSelectedBlockId(manualId);
    requestSelectionPaperExplanation(manualId, selectedText, currentDocumentId);
    highlighterUtilsRef.current?.removeGhostHighlight();
    // 清理浏览器原生选区，避免松手后蓝色选中残留
    const clearNativeSelection = () => {
      window.getSelection()?.removeAllRanges();
    };
    clearNativeSelection();
    window.setTimeout(clearNativeSelection, 0);
    window.setTimeout(clearNativeSelection, 40);
  }

  function requestSelectionPaperExplanation(highlightId: string, selectedText: string, documentId: string | null) {
    const text = selectedText.trim();
    if (!highlightId || !text) {
      return;
    }
    if (selectionExplainByHighlightId[highlightId]) {
      setSelectionExplainStatusByHighlightId((current) => ({
        ...current,
        [highlightId]: "completed"
      }));
      return;
    }
    if (selectionExplainingIdsRef.current.has(highlightId)) {
      return;
    }
    selectionExplainingIdsRef.current.add(highlightId);
    setSelectionExplainStatusByHighlightId((current) => ({
      ...current,
      [highlightId]: "running"
    }));
    setSelectionExplainStreamByHighlightId((current) => ({
      ...current,
      [highlightId]: ""
    }));
    void invoke<SelectionPaperExplainResponse>("explain_selection_text_command", {
      payload: {
        selectedText: text.slice(0, 8000),
        documentId: documentId ?? undefined,
        requestId: highlightId
      }
    })
      .then((result) => {
        setSelectionExplainByHighlightId((current) => ({
          ...current,
          [highlightId]: result
        }));
        setSelectionExplainStatusByHighlightId((current) => ({
          ...current,
          [highlightId]: "completed"
        }));
      })
      .catch(() => {
        setSelectionExplainStatusByHighlightId((current) => ({
          ...current,
          [highlightId]: "failed"
        }));
      })
      .finally(() => {
        selectionExplainingIdsRef.current.delete(highlightId);
      });
  }

  useEffect(() => {
    const manualHighlights = viewerHighlights.filter((item) => item.id.startsWith("manual-"));
    for (const item of manualHighlights) {
      const selectedText = item.content?.text || item.detail || "";
      if (!selectedText.trim()) {
        continue;
      }
      if (!selectionExplainByHighlightId[item.id]) {
        requestSelectionPaperExplanation(item.id, selectedText, currentDocumentId);
      }
    }
  }, [currentDocumentId, selectionExplainByHighlightId, viewerHighlights]);

  if (!currentProject) {
    return <section className="pdf-reader-shell"><div className="surface-empty">先在左侧创建并打开一个项目。</div></section>;
  }
  if (documents.length === 0) {
    return <section className="pdf-reader-shell"><div className="surface-empty">当前项目没有资料。先从左侧导入文档。</div></section>;
  }
  if (!currentDocument) {
    return <section className="pdf-reader-shell"><div className="surface-empty">请在左侧项目树中选择一份文档。</div></section>;
  }

  return (
    <section className="pdf-reader-shell pdf-reader-shell-immersive">
      {pdfState === "failed" ? (
        <div className="surface-empty">{pdfMessage ?? "PDF 预览失败。"}</div>
      ) : (
        <div
          ref={pdfViewportRef}
          className="pdf-preview-viewport pdf-preview-viewport-immersive"
        >
          {pdfState !== "ready" || !pdfDocumentConfig ? (
            <div className="pdf-preview-status">{pdfMessage ?? "正在准备 PDF…"}</div>
          ) : (
            <div className="pdf-reader-canvas-layout">
              <div
                ref={highlighterShellRef}
                className="pdf-highlighter-shell pdf-highlighter-shell-immersive"
                style={{
                  ["--pdf-callout-right-space" as string]: `${pdfRightReservedSpace}px`
                }}
              >
                <PdfLoader document={pdfDocumentConfig} workerSrc={pdfWorkerUrl}>
                  {(pdfDocument) => (
                    <>
                      <PdfHighlighter
                        pdfDocument={pdfDocument}
                        highlights={viewerHighlights}
                        pdfScaleValue="auto"
                        enableAreaSelection={() => false}
                        onSelection={handlePdfSelection}
                        textSelectionColor="rgba(122, 162, 255, 0.35)"
                        utilsRef={(utils) => {
                          highlighterUtilsRef.current = utils;
                        }}
                      >
                        <PdfBlockHighlightContainer
                          selectedBlockId={selectedBlockId}
                          onSelectBlock={handleSelectBlock}
                          blockLookup={blockLookup}
                          selectionExplainByHighlightId={selectionExplainByHighlightId}
                          selectionExplainStatusByHighlightId={selectionExplainStatusByHighlightId}
                        selectionExplainStreamByHighlightId={selectionExplainStreamByHighlightId}
                        collapsedByHighlightId={collapsedByHighlightId}
                        calloutLayoutByHighlightId={manualCalloutLayoutByHighlightId}
                        calloutCardWidth={calloutCardWidth}
                        pdfRightReservedSpace={pdfRightReservedSpace}
                        onToggleCollapse={(highlightId) => {
                          setCollapsedByHighlightId((current) => ({
                            ...current,
                            [highlightId]: !(current[highlightId] !== false)
                          }));
                        }}
                      />
                    </PdfHighlighter>
                  </>
                )}
              </PdfLoader>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

interface ViewerHighlight extends Highlight {
  blockId?: string;
  label?: string;
  snippet?: string;
  detail?: string;
}

function PdfBlockHighlightContainer({
  selectedBlockId,
  onSelectBlock,
  blockLookup,
  selectionExplainByHighlightId,
  selectionExplainStatusByHighlightId,
  selectionExplainStreamByHighlightId,
  collapsedByHighlightId,
  calloutLayoutByHighlightId,
  calloutCardWidth,
  pdfRightReservedSpace,
  onToggleCollapse
}: {
  selectedBlockId: string | null;
  onSelectBlock: (blockId: string) => void;
  blockLookup: Map<string, { title: string; snippet: string }>;
  selectionExplainByHighlightId: Record<string, SelectionPaperExplainResponse>;
  selectionExplainStatusByHighlightId: Record<string, ExplainRunStatus>;
  selectionExplainStreamByHighlightId: Record<string, string>;
  collapsedByHighlightId: Record<string, boolean>;
  calloutLayoutByHighlightId: Record<string, { top: number; height: number }>;
  calloutCardWidth: number;
  pdfRightReservedSpace: number;
  onToggleCollapse: (highlightId: string) => void;
}) {
  const { highlight, isScrolledTo, highlightBindings } = useHighlightContainerContext<ViewerHighlight>();
  const [isHovering, setIsHovering] = useState(false);
  const hoverOutTimerRef = useRef<number | null>(null);
  const active = Boolean(
    (highlight.blockId && highlight.blockId === selectedBlockId)
    || highlight.id === selectedBlockId
  );
  const isManualHighlight = highlight.id.startsWith("manual-");
  const blockInfo = highlight.blockId ? blockLookup.get(highlight.blockId) : null;
  const manualSelectionExplanation = selectionExplainByHighlightId[highlight.id] ?? null;
  const parsedExplanation = manualSelectionExplanation
    ? parseManualSelectionExplanation(manualSelectionExplanation)
    : null;
  const explainStatus = selectionExplainStatusByHighlightId[highlight.id] ?? "idle";
  const streamText = selectionExplainStreamByHighlightId[highlight.id] ?? "";
  const isExplainLoading = Boolean(!parsedExplanation && explainStatus === "running");
  const isExplainFailed = Boolean(!parsedExplanation && explainStatus === "failed");
  const calloutTitle = "学习解析";
  const calloutSnippetRaw = blockInfo?.snippet || highlight.snippet || highlight.content?.text || "自动匹配结果";
  const calloutSnippet = calloutSnippetRaw.slice(0, 50);
  const keyPointSummary = parsedExplanation?.keyPoints.slice(0, 2).join("；").trim();
  const learningSummary = keyPointSummary || parsedExplanation?.summary || calloutSnippet;
  const plainSummary = parsedExplanation?.plainExplanation || calloutSnippet;
  const highlightKey = highlight.blockId ?? highlight.id;
  const textLayer = highlightBindings.textLayer;
  const layerWidth = textLayer.clientWidth || 0;
  const highlighterRoot = textLayer.closest(".PdfHighlighter") as HTMLElement | null;
  const highlighterWidth = highlighterRoot?.clientWidth || layerWidth + 520;
  const rect = highlight.position.boundingRect;
  const rectLeft = getScaledRectValue(rect, ["left", "x1"], 0);
  const rectTop = getScaledRectValue(rect, ["top", "y1"], 0);
  const rectWidth = getScaledRectDimension(rect, ["width"], ["x1", "x2"], 0);
  const rectHeight = getScaledRectDimension(rect, ["height"], ["y1", "y2"], 0);
  const showKeyPointsOnly = collapsedByHighlightId[highlight.id] !== false;
  const layoutInfo = calloutLayoutByHighlightId[highlight.id];
  const cardLaneLeft = Math.max(8, highlighterWidth - pdfRightReservedSpace + 10);
  const laneAvailableWidth = Math.max(200, highlighterWidth - cardLaneLeft - 12);
  const cardWidth = clampValue(Math.min(calloutCardWidth, laneAvailableWidth), 200, 420);
  const cardHeight = layoutInfo?.height ?? estimateManualCalloutHeight(parsedExplanation, explainStatus, showKeyPointsOnly);
  const preferredCardLeft = Math.max(cardLaneLeft, layerWidth + 20);
  const maxCardLeft = Math.max(8, highlighterWidth - cardWidth - 10);
  const cardLeft = Math.min(preferredCardLeft, maxCardLeft);
  const cardTop = layoutInfo?.top ?? Math.max(8, rectTop - 8);
  const anchorX = rectLeft + rectWidth;
  const anchorY = rectTop + rectHeight / 2;
  const connectorX = cardLeft - 10;
  const connectorY = cardTop + Math.min(cardHeight - 18, Math.max(18, cardHeight * 0.5));
  const frameLeft = Math.max(0, rectLeft - 2);
  const frameTop = Math.max(0, rectTop - 2);
  const frameWidth = Math.max(0, rectWidth + 4);
  const frameHeight = Math.max(0, rectHeight + 4);
  const confidenceLabel = parsedExplanation ? mapConfidenceLabel(parsedExplanation.confidence) : "";
  const keyPointsPreview = parsedExplanation?.keyPoints.slice(0, 3) ?? [];

  const clearHoverOutTimer = () => {
    if (hoverOutTimerRef.current !== null) {
      window.clearTimeout(hoverOutTimerRef.current);
      hoverOutTimerRef.current = null;
    }
  };

  const handleHighlightMouseOver = () => {
    clearHoverOutTimer();
    setIsHovering(true);
  };

  const handleHighlightMouseOut = () => {
    clearHoverOutTimer();
    hoverOutTimerRef.current = window.setTimeout(() => {
      setIsHovering(false);
    }, 60);
  };

  useEffect(() => () => {
    clearHoverOutTimer();
  }, []);

  return (
    <>
      <TextHighlight
        highlight={highlight}
        isScrolledTo={isScrolledTo}
        onMouseOver={handleHighlightMouseOver}
        onMouseOut={handleHighlightMouseOut}
        style={{
          background: "transparent"
        }}
      onClick={() => {
        onSelectBlock(highlightKey);
      }}
    />
      {isManualHighlight ? (
        <div
          className={isHovering ? "pdf-highlight-flow-frame pdf-highlight-flow-frame-hover" : "pdf-highlight-flow-frame"}
          style={{
            left: `${frameLeft}px`,
            top: `${frameTop}px`,
            width: `${frameWidth}px`,
            height: `${frameHeight}px`
          }}
        >
          <svg
            className="pdf-highlight-flow-line"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <rect
              x="0.9"
              y="0.9"
              width="98.2"
              height="98.2"
              rx="2.8"
              ry="2.8"
              pathLength="100"
            />
          </svg>
        </div>
      ) : null}
      {highlightKey ? (
        <>
          <div
            className={active ? "pdf-highlight-connector pdf-highlight-connector-active" : "pdf-highlight-connector"}
            style={buildConnectorStyle(anchorX, anchorY, connectorX, connectorY)}
          />
          <div
            className={
              active
                ? `pdf-highlight-callout pdf-highlight-callout-active${isExplainLoading ? " pdf-highlight-callout-loading" : ""}`
                : `pdf-highlight-callout${isExplainLoading ? " pdf-highlight-callout-loading" : ""}`
            }
            style={{
              left: `${cardLeft}px`,
              top: `${cardTop}px`,
              width: `${cardWidth}px`,
              minHeight: `${cardHeight}px`
            }}
            role="button"
            tabIndex={0}
            onClick={() => onSelectBlock(highlightKey)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectBlock(highlightKey);
              }
            }}
          >
            <div className="pdf-highlight-callout-header">
              <div className="pdf-highlight-callout-title">{calloutTitle}</div>
              {parsedExplanation ? (
                <button
                  type="button"
                  className="pdf-highlight-callout-toggle"
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleCollapse(highlight.id);
                  }}
                  title={showKeyPointsOnly ? "展开完整学习解析" : "收纳为学习要点"}
                >
                  {showKeyPointsOnly ? "▸" : "▾"}
                </button>
              ) : null}
            </div>
            {isExplainLoading ? (
              <>
                <div className="pdf-highlight-callout-tag">学习解析模式：解析中</div>
                <div className="pdf-highlight-callout-loading-line" />
                {streamText ? (
                  <div className="pdf-highlight-callout-stream">{streamText}</div>
                ) : (
                  <div className="pdf-highlight-callout-snippet">正在生成学习解析内容...</div>
                )}
              </>
            ) : null}
            {isExplainFailed ? (
              <>
                <div className="pdf-highlight-callout-tag">学习解析模式：失败</div>
                <div className="pdf-highlight-callout-snippet">解析失败，点击该卡片可重新触发。</div>
              </>
            ) : null}
            {!isExplainLoading && !isExplainFailed && parsedExplanation ? (
              <>
                <div className="pdf-highlight-callout-tag">
                  学习解析模式{confidenceLabel ? ` · ${confidenceLabel}` : ""}
                </div>
                <div className="pdf-highlight-callout-label">学习要点</div>
                <div className="pdf-highlight-callout-snippet">{parsedExplanation.summary}</div>
                {showKeyPointsOnly && keyPointsPreview.length > 0 ? (
                  <ul className="pdf-highlight-callout-list">
                    {keyPointsPreview.map((item, index) => (
                      <li key={`kp-${highlight.id}-${index}`}>{item}</li>
                    ))}
                  </ul>
                ) : null}
                {!showKeyPointsOnly ? (
                  <>
                    <div className="pdf-highlight-callout-label">前置知识</div>
                    {renderCalloutList(parsedExplanation.prerequisites, "当前块未提供充分信息")}
                    <div className="pdf-highlight-callout-label">重点清单</div>
                    {renderCalloutList(parsedExplanation.keyPoints, "当前块未提炼明确重点")}
                    <div className="pdf-highlight-callout-label">术语解释</div>
                    {parsedExplanation.terms.length > 0 ? (
                      <div className="pdf-highlight-callout-terms">
                        {parsedExplanation.terms.map((item, index) => (
                          <div key={`term-${highlight.id}-${index}`} className="pdf-highlight-callout-term-item">
                            <div className="pdf-highlight-callout-term-name">{item.term}</div>
                            <div className="pdf-highlight-callout-term-explain">{item.explanation}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="pdf-highlight-callout-snippet">当前块未提供充分信息</div>
                    )}
                    <div className="pdf-highlight-callout-label">常见误区</div>
                    {renderCalloutList(parsedExplanation.pitfalls, "当前块未体现")}
                    <div className="pdf-highlight-callout-label">理解例子</div>
                    {renderCalloutList(parsedExplanation.examples, "当前块未给出可直接类比的例子")}
                    <div className="pdf-highlight-callout-label">继续拓展</div>
                    {renderCalloutList(parsedExplanation.extension, "建议结合上下文继续深入阅读后续章节")}
                    <div className="pdf-highlight-callout-label">直白解释</div>
                    <div className="pdf-highlight-callout-snippet">{parsedExplanation.plainExplanation}</div>
                  </>
                ) : null}
              </>
            ) : null}
            {!isExplainLoading && !isExplainFailed && !parsedExplanation ? (
              <>
                <div className="pdf-highlight-callout-tag">学习解析模式</div>
                <div className="pdf-highlight-callout-snippet">{learningSummary}</div>
                <div className="pdf-highlight-callout-label">直白解释</div>
                <div className="pdf-highlight-callout-snippet">{plainSummary}</div>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}

function SimplePaperExplain({ explanation }: { explanation: BlockExplanation }) {
  const parsed = safeParsePaperJson(explanation.rawResponseJson);
  const summary = parsed?.summary || explanation.summary || "当前块已完成解析。";
  const plainExplanation = parsed?.plainExplanation || summary;
  const keyPoints = Array.isArray(parsed?.keyPoints) ? parsed.keyPoints : [];
  const prerequisites = Array.isArray(parsed?.prerequisites) ? parsed.prerequisites : [];

  return (
    <div className="pdf-explain-result">
      <section className="pdf-explain-section">
        <div className="pdf-explain-label">学习要点</div>
        <div className="pdf-explain-text">{summary}</div>
      </section>
      <section className="pdf-explain-section">
        <div className="pdf-explain-label">直白解释</div>
        <div className="pdf-explain-text">{plainExplanation}</div>
      </section>
      {keyPoints.length > 0 ? (
        <section className="pdf-explain-section">
          <div className="pdf-explain-label">重点清单</div>
          <ul className="pdf-explain-list">
            {keyPoints.map((item, index) => (
              <li key={`${index}-${item}`}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {prerequisites.length > 0 ? (
        <section className="pdf-explain-section">
          <div className="pdf-explain-label">前置知识</div>
          <ul className="pdf-explain-list">
            {prerequisites.map((item, index) => (
              <li key={`${index}-${item}`}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function findBestMatchedBlock(selectedText: string, blocks: Block[]) {
  const normalizedSelection = normalizeForMatch(selectedText);
  if (normalizedSelection.length < 4 || blocks.length === 0) {
    return null;
  }
  let best: { block: Block; score: number } | null = null;
  for (const block of blocks) {
    const blockText = normalizeForMatch(`${block.title ?? ""} ${toPlainText(block.contentMd)}`);
    const score = calculateTextMatchScore(normalizedSelection, blockText);
    if (!best || score > best.score) {
      best = { block, score };
    }
  }
  if (!best) {
    return null;
  }
  if (best.score >= 0.16) {
    return best.block;
  }
  const relaxedThreshold = normalizedSelection.length >= 24 ? 0.08 : 0.11;
  if (best.score >= relaxedThreshold) {
    return best.block;
  }
  if (normalizedSelection.length >= 14 && best.score >= 0.04) {
    return best.block;
  }
  return null;
}

interface PageTextItem {
  normalizedText: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface PageMatchCache {
  pageNumber: number;
  width: number;
  height: number;
  items: PageTextItem[];
  joinedText: string;
  offsets: Array<{ start: number; end: number }>;
}

async function generateAutoHighlightsFromBlocks(pdfDocument: any, blocks: Block[]): Promise<ViewerHighlight[]> {
  const caches = new Map<number, PageMatchCache>();
  const highlights: ViewerHighlight[] = [];
  const sorted = [...blocks].sort((a, b) => a.orderIndex - b.orderIndex).slice(0, 120);
  for (const block of sorted) {
    const pageNumber = inferPageFromBlock(block);
    if (!pageNumber || pageNumber < 1 || pageNumber > (pdfDocument.numPages || 1)) {
      continue;
    }
    let cache = caches.get(pageNumber);
    if (!cache) {
      cache = await buildPageMatchCache(pdfDocument, pageNumber);
      caches.set(pageNumber, cache);
    }
    const snippet = normalizeForMatch(toPlainText(block.contentMd)).slice(0, 120);
    const range = locateItemRange(cache, snippet);
    if (!range) {
      continue;
    }
    const selectedItems = cache.items.slice(range.fromIndex, range.toIndex + 1);
    if (selectedItems.length === 0) {
      continue;
    }
    const left = Math.min(...selectedItems.map((item) => item.left));
    const top = Math.min(...selectedItems.map((item) => item.top));
    const right = Math.max(...selectedItems.map((item) => item.right));
    const bottom = Math.max(...selectedItems.map((item) => item.bottom));
    const blockHeight = bottom - top;
    if (blockHeight > cache.height * 0.42) {
      continue;
    }
    highlights.push({
      id: `auto-${block.blockId}`,
      type: "text",
      blockId: block.blockId,
      content: { text: toPlainText(block.contentMd).slice(0, 180) },
      position: {
        boundingRect: {
          x1: left,
          y1: top,
          x2: right,
          y2: bottom,
          width: cache.width,
          height: cache.height,
          pageNumber
        },
        rects: [{
          x1: left,
          y1: top,
          x2: right,
          y2: bottom,
          width: cache.width,
          height: cache.height,
          pageNumber
        }]
      }
    });
  }
  return highlights;
}

async function buildPageMatchCache(pdfDocument: any, pageNumber: number): Promise<PageMatchCache> {
  const page = await pdfDocument.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent();
  const items: PageTextItem[] = [];
  for (const rawItem of textContent.items as Array<Record<string, unknown>>) {
    const str = typeof rawItem.str === "string" ? rawItem.str : "";
    const normalized = normalizeForMatch(str);
    if (!normalized) {
      continue;
    }
    if (!Array.isArray(rawItem.transform)) {
      continue;
    }
    const transformed = Util.transform(viewport.transform, rawItem.transform as number[]);
    const left = Number(transformed[4] ?? 0);
    const baselineY = Number(transformed[5] ?? 0);
    const height = Math.max(1, Math.hypot(Number(transformed[2] ?? 0), Number(transformed[3] ?? 0)));
    const width = Math.max(1, Number(rawItem.width ?? 0) * viewport.scale);
    const top = baselineY - height;
    items.push({
      normalizedText: normalized,
      left,
      top,
      right: left + width,
      bottom: top + height
    });
  }
  let joinedText = "";
  const offsets: Array<{ start: number; end: number }> = [];
  for (const item of items) {
    const start = joinedText.length;
    joinedText += item.normalizedText;
    offsets.push({ start, end: joinedText.length });
  }
  return {
    pageNumber,
    width: viewport.width,
    height: viewport.height,
    items,
    joinedText,
    offsets
  };
}

function locateItemRange(cache: PageMatchCache, normalizedSnippet: string) {
  if (!normalizedSnippet || cache.items.length === 0 || !cache.joinedText) {
    return null;
  }
  const probeLengths = [56, 42, 28, 18, 10];
  for (const len of probeLengths) {
    if (normalizedSnippet.length < len) {
      continue;
    }
    const probe = normalizedSnippet.slice(0, len);
    const foundAt = cache.joinedText.indexOf(probe);
    if (foundAt < 0) {
      continue;
    }
    const endAt = foundAt + probe.length;
    let fromIndex = 0;
    let toIndex = cache.offsets.length - 1;
    for (let i = 0; i < cache.offsets.length; i += 1) {
      if (cache.offsets[i]!.end > foundAt) {
        fromIndex = i;
        break;
      }
    }
    for (let i = fromIndex; i < cache.offsets.length; i += 1) {
      if (cache.offsets[i]!.start >= endAt) {
        toIndex = Math.max(fromIndex, i - 1);
        break;
      }
      toIndex = i;
    }
    return { fromIndex, toIndex };
  }
  return null;
}

interface RawTextPiece {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface TextLineGroup {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface TextParagraphGroup {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type PreviewBlockKind = "title" | "code" | "list" | "paragraph";

interface PreviewBlock extends TextParagraphGroup {
  kind: PreviewBlockKind;
  lineCount: number;
}

async function generatePreviewHighlightsForPage(pdfDocument: any, pageNumber: number): Promise<ViewerHighlight[]> {
  const page = await pdfDocument.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent();
  const pieces: RawTextPiece[] = [];
  for (const item of textContent.items as Array<Record<string, unknown>>) {
    const text = typeof item.str === "string" ? item.str.trim() : "";
    if (!text) {
      continue;
    }
    if (!Array.isArray(item.transform)) {
      continue;
    }
    const transform = Util.transform(viewport.transform, item.transform as number[]);
    const left = Number(transform[4] ?? 0);
    const baselineY = Number(transform[5] ?? 0);
    const height = Math.max(1, Math.hypot(Number(transform[2] ?? 0), Number(transform[3] ?? 0)));
    const width = Math.max(1, Number(item.width ?? 0) * viewport.scale);
    const top = baselineY - height;
    pieces.push({
      text,
      left,
      top,
      right: left + width,
      bottom: top + height
    });
  }
  if (pieces.length === 0) {
    return [];
  }
  const lines = groupTextPiecesByLine(pieces).filter((line) => shouldKeepPreviewLine(line.text));
  const semanticBlocks = buildSemanticPreviewBlocks(lines);
  const targetCount = clampValue(Math.round(lines.length / 22), 4, 7);
  const selectedBlocks = selectSemanticPreviewBlocks(semanticBlocks, targetCount, viewport.height);
  return selectedBlocks.map((block, index) => {
    const id = `gen-p${pageNumber}-i${index}`;
    return {
      id,
      blockId: id,
      type: "text",
      label: `第 ${pageNumber} 页 · 预览${previewKindLabel(block.kind)}${index + 1}`,
      snippet: block.text.slice(0, 60),
      detail: block.text,
      content: { text: block.text.slice(0, 240) },
      position: {
        boundingRect: {
          x1: block.left,
          y1: block.top,
          x2: block.right,
          y2: block.bottom,
          width: viewport.width,
          height: viewport.height,
          pageNumber
        },
        rects: [{
          x1: block.left,
          y1: block.top,
          x2: block.right,
          y2: block.bottom,
          width: viewport.width,
          height: viewport.height,
          pageNumber
        }]
      }
    } satisfies ViewerHighlight;
  });
}

function groupTextPiecesByLine(pieces: RawTextPiece[]): TextLineGroup[] {
  const lineTolerance = 4;
  const sorted = [...pieces].sort((a, b) => {
    if (Math.abs(a.top - b.top) < 3) {
      return a.left - b.left;
    }
    return a.top - b.top;
  });
  const lineBuckets = new Map<number, { items: RawTextPiece[]; top: number }>();
  for (const piece of sorted) {
    const bucketKey = Math.round(piece.top / lineTolerance);
    const target =
      lineBuckets.get(bucketKey)
      ?? lineBuckets.get(bucketKey - 1)
      ?? lineBuckets.get(bucketKey + 1);
    if (target) {
      target.items.push(piece);
      target.top = (target.top + piece.top) / 2;
    } else {
      lineBuckets.set(bucketKey, { items: [piece], top: piece.top });
    }
  }
  return Array.from(lineBuckets.values())
    .sort((a, b) => a.top - b.top)
    .map((line) => {
    const ordered = line.items.sort((a, b) => a.left - b.left);
    return {
      text: ordered.map((item) => item.text).join(" ").trim(),
      left: Math.min(...ordered.map((item) => item.left)),
      top: Math.min(...ordered.map((item) => item.top)),
      right: Math.max(...ordered.map((item) => item.right)),
      bottom: Math.max(...ordered.map((item) => item.bottom))
    };
  }).filter((line) => line.text.length > 0);
}

function buildSemanticPreviewBlocks(lines: TextLineGroup[]): PreviewBlock[] {
  if (lines.length === 0) {
    return [];
  }
  const sorted = [...lines].sort((a, b) => a.top - b.top);
  const lineHeights = sorted.map((line) => Math.max(1, line.bottom - line.top)).sort((a, b) => a - b);
  const medianHeight = lineHeights[Math.floor(lineHeights.length / 2)] ?? 14;
  const regularGapThreshold = Math.max(18, medianHeight * 1.8);
  const codeGapThreshold = Math.max(12, medianHeight * 2.2);
  const leftSplitThreshold = 80;
  const blocks: PreviewBlock[] = [];
  let current: PreviewBlock | null = null;
  for (const line of sorted) {
    const lineKind = detectPreviewLineKind(line.text);
    if (!current) {
      current = {
        ...line,
        kind: lineKind,
        lineCount: 1
      };
      continue;
    }
    const gap = line.top - current.bottom;
    const lineLimit = current.kind === "code" ? 24 : current.kind === "title" ? 2 : 16;
    const gapThreshold =
      current.kind === "code" || lineKind === "code"
        ? codeGapThreshold
        : regularGapThreshold;
    const leftDrift = Math.abs(line.left - current.left);
    const kindSwitch = current.kind !== lineKind;
    const shouldSplit =
      gap > gapThreshold
      || current.kind === "title"
      || (current.kind === "code" && lineKind !== "code")
      || (current.kind !== "code" && lineKind === "code")
      || (kindSwitch && current.kind !== "paragraph" && lineKind !== "paragraph")
      || (leftDrift > leftSplitThreshold && gap > medianHeight * 0.9)
      || current.lineCount >= lineLimit;
    if (shouldSplit) {
      blocks.push(current);
      current = {
        ...line,
        kind: lineKind,
        lineCount: 1
      };
      continue;
    }
    current = {
      text: `${current.text} ${line.text}`.trim(),
      left: Math.min(current.left, line.left),
      top: Math.min(current.top, line.top),
      right: Math.max(current.right, line.right),
      bottom: Math.max(current.bottom, line.bottom),
      kind: mergePreviewKind(current.kind, lineKind),
      lineCount: current.lineCount + 1
    };
  }
  if (current) {
    blocks.push(current);
  }
  return blocks.filter((block) => {
    if (block.kind === "code") {
      return normalizeForMatch(block.text).length >= 6;
    }
    return normalizeForMatch(block.text).length >= 16;
  });
}

function detectPreviewLineKind(text: string): PreviewBlockKind {
  const value = text.trim();
  if (!value) {
    return "paragraph";
  }
  const titleLike =
    /^第[\d一二三四五六七八九十百零]{1,4}[章节篇回]/.test(value)
    || /^(\d+(\.\d+){0,3}|[IVXLC]+)\s+/.test(value)
    || (/^[A-Z][A-Za-z0-9\s\-:]{2,40}$/.test(value) && value.length < 48);
  if (titleLike) {
    return "title";
  }
  const listLike = /^(\d+[\.、)]|[\-•*]|[（(]\d+[)）])\s*/.test(value);
  if (listLike) {
    return "list";
  }
  const cjkCount = (value.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const letterCount = (value.match(/[A-Za-z_]/g) ?? []).length;
  const digitCount = (value.match(/\d/g) ?? []).length;
  const symbolCount = (value.match(/[{}();=<>#\[\]]/g) ?? []).length;
  const operatorCount = (value.match(/(::|->|=>|==|!=|<=|>=|\+\+|--)/g) ?? []).length;
  const trimmedLength = value.length;
  const cjkRatio = trimmedLength > 0 ? cjkCount / trimmedLength : 0;

  const strongCodeSignal =
    /[#{};]|(::|->|=>)/.test(value)
    || /\b(if|else|for|while|switch|case|return|class|struct|template|public|private|protected|void|int|char|string|const|static|include|using|namespace|cout|cin)\b/i.test(value)
    || /^#\s*include\b/i.test(value)
    || /^[\s\t]*[A-Za-z_][A-Za-z0-9_:<>*\s]+\([^)]*\)\s*\{?\s*$/.test(value)
    || /^[\s\t]*[A-Za-z_][A-Za-z0-9_]*\s*=\s*.+;?\s*$/.test(value);
  if (strongCodeSignal) {
    return "code";
  }

  const weakCodeSignal =
    /\b[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)/.test(value)
    || (symbolCount >= 2 && letterCount >= 2)
    || (operatorCount >= 1 && letterCount >= 2);
  const likelyNaturalLanguage =
    cjkRatio >= 0.18
    && symbolCount <= 1
    && !/[{};]/.test(value)
    && (value.includes("函数") || value.includes("语句") || value.includes("程序") || value.includes("比如") || value.includes("例如"));
  if (weakCodeSignal && !likelyNaturalLanguage && (letterCount + digitCount >= 6 || cjkRatio < 0.12)) {
    return "code";
  }
  return "paragraph";
}

function selectSemanticPreviewBlocks(blocks: PreviewBlock[], maxCount: number, pageHeight: number) {
  const ordered = [...blocks].sort((a, b) => a.top - b.top);
  if (ordered.length <= maxCount) {
    return ordered;
  }
  const picked: PreviewBlock[] = [];
  const pushUnique = (item: PreviewBlock) => {
    if (!picked.includes(item)) {
      picked.push(item);
    }
  };
  const firstTitle = ordered.find((item) => item.kind === "title");
  if (firstTitle) {
    pushUnique(firstTitle);
  }
  const keyCodes = ordered
    .filter((item) => item.kind === "code")
    .sort((a, b) => previewBlockScore(b) - previewBlockScore(a))
    .slice(0, 1);
  for (const block of keyCodes) {
    pushUnique(block);
  }
  const effectivePageHeight = Math.max(
    pageHeight,
    ordered[ordered.length - 1]?.bottom ?? pageHeight
  );
  const bandCount = Math.min(maxCount, 4);
  for (let band = 0; band < bandCount; band += 1) {
    if (picked.length >= maxCount) {
      break;
    }
    const bandStart = (effectivePageHeight / bandCount) * band;
    const bandEnd = (effectivePageHeight / bandCount) * (band + 1);
    const inBand = ordered.filter((item) => {
      if (picked.includes(item)) {
        return false;
      }
      const center = (item.top + item.bottom) / 2;
      return center >= bandStart && center <= bandEnd;
    });
    if (inBand.length === 0) {
      continue;
    }
    inBand.sort((a, b) => previewBlockScore(b) - previewBlockScore(a));
    pushUnique(inBand[0]!);
  }
  if (picked.length < maxCount) {
    const fallback = ordered
      .filter((item) => !picked.includes(item))
      .sort((a, b) => previewBlockScore(b) - previewBlockScore(a));
    for (const block of fallback) {
      if (picked.length >= maxCount) {
        break;
      }
      pushUnique(block);
    }
  }
  return picked
    .sort((a, b) => a.top - b.top)
    .slice(0, maxCount);
}

function shouldKeepPreviewLine(text: string) {
  const value = text.trim();
  if (!value) {
    return false;
  }
  const normalized = normalizeForMatch(value);
  if (normalized.length >= 4) {
    return true;
  }
  const kind = detectPreviewLineKind(value);
  if (kind === "code" || kind === "title") {
    return true;
  }
  return /[\u4e00-\u9fffA-Za-z0-9]/.test(value) && value.length >= 2;
}

function mergePreviewKind(current: PreviewBlockKind, next: PreviewBlockKind): PreviewBlockKind {
  if (current === next) {
    return current;
  }
  if (current === "title" || next === "title") {
    return "title";
  }
  if (current === "code" || next === "code") {
    return "code";
  }
  if (current === "list" || next === "list") {
    return "list";
  }
  return "paragraph";
}

function previewBlockScore(block: PreviewBlock) {
  const kindWeight =
    block.kind === "title"
      ? 2.3
      : block.kind === "code"
        ? 2.1
        : block.kind === "list"
          ? 1.6
          : 1.2;
  const textLengthScore = Math.min(1.5, normalizeForMatch(block.text).length / 70);
  const lineScore = Math.min(1.4, block.lineCount / 6);
  return kindWeight + textLengthScore + lineScore;
}

function previewKindLabel(kind: PreviewBlockKind) {
  if (kind === "title") {
    return "标题块";
  }
  if (kind === "code") {
    return "代码块";
  }
  if (kind === "list") {
    return "列表块";
  }
  return "段落块";
}

function calculateTextMatchScore(selection: string, blockText: string) {
  if (!selection || !blockText) {
    return 0;
  }
  if (blockText.includes(selection)) {
    return Math.min(1, 0.78 + Math.min(0.2, selection.length / Math.max(blockText.length, 1)));
  }
  if (selection.includes(blockText)) {
    return Math.min(1, 0.62 + Math.min(0.25, blockText.length / Math.max(selection.length, 1)));
  }
  const selectionNgrams = buildNgrams(selection, 2);
  const blockNgrams = buildNgrams(blockText, 2);
  if (selectionNgrams.size === 0 || blockNgrams.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const gram of selectionNgrams) {
    if (blockNgrams.has(gram)) {
      overlap += 1;
    }
  }
  const union = selectionNgrams.size + blockNgrams.size - overlap;
  return union > 0 ? overlap / union : 0;
}

function buildNgrams(text: string, size: number) {
  const grams = new Set<string>();
  if (text.length <= size) {
    if (text) {
      grams.add(text);
    }
    return grams;
  }
  for (let index = 0; index <= text.length - size; index += 1) {
    grams.add(text.slice(index, index + size));
  }
  return grams;
}

function normalizeForMatch(input: string) {
  return input
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？、；：“”‘’（）\(\)\[\]\{\}<>\-_=+*`~|\\\/'"^$#@&.,!?;:]/g, "");
}

function buildConnectorStyle(fromX: number, fromY: number, toX: number, toY: number) {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const length = Math.max(1, Math.hypot(dx, dy));
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  return {
    left: `${fromX}px`,
    top: `${fromY}px`,
    width: `${length}px`,
    transform: `rotate(${angle}deg)`
  };
}

function clampValue(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function safeParsePaperJson(input: string) {
  try {
    return JSON.parse(input) as {
      summary?: string;
      plainExplanation?: string;
      keyPoints?: string[];
      prerequisites?: string[];
      parsed_content?: Record<string, unknown>;
    };
  } catch {
    return null;
  }
}

function parsePaperExplanationForCallout(explanation: BlockExplanation) {
  const parsed = safeParsePaperJson(explanation.rawResponseJson);
  const parsedContent = parsed?.parsed_content ?? null;
  const keyPoints = normalizePaperStringList(
    parsed?.keyPoints
    ?? readParsedContentStringList(parsedContent, ["key_points", "最重要要点", "最重要的要点", "要点", "重点"])
    ?? safeParseStringList(explanation.keyConceptsJson)
    ?? []
  );
  const summary = (
    parsed?.summary
    ?? readParsedContentString(parsedContent, ["what_is_this_block_about", "当前块主题", "当前块内容概述"])
    ?? explanation.summary
    ?? "当前块已完成解析。"
  ).trim();
  const plainExplanation = (
    parsed?.plainExplanation
    ?? readParsedContentString(parsedContent, ["plain_language_explanation", "plain_explanation", "直白解释"])
    ?? summary
  ).trim();
  return {
    summary,
    plainExplanation,
    keyPoints
  };
}

function parseManualSelectionExplanation(explanation: SelectionPaperExplainResponse) {
  const summary = explanation.summary?.trim() || "已基于选中文本完成学习解析。";
  const plainExplanation = explanation.plainExplanation?.trim() || summary;
  const keyPoints = Array.isArray(explanation.keyPoints)
    ? explanation.keyPoints.map((item) => item.trim()).filter(Boolean)
    : [];
  const prerequisites = Array.isArray(explanation.prerequisites)
    ? explanation.prerequisites.map((item) => item.trim()).filter(Boolean)
    : [];
  const pitfalls = Array.isArray(explanation.pitfalls)
    ? explanation.pitfalls.map((item) => item.trim()).filter(Boolean)
    : [];
  const examples = Array.isArray(explanation.examples)
    ? explanation.examples.map((item) => item.trim()).filter(Boolean)
    : [];
  const extension = Array.isArray(explanation.extension)
    ? explanation.extension.map((item) => item.trim()).filter(Boolean)
    : [];
  const terms = normalizeSelectionExplainTerms(explanation.terms);
  return {
    summary,
    plainExplanation,
    keyPoints,
    prerequisites,
    pitfalls,
    examples,
    extension,
    terms,
    confidence: explanation.confidence
  };
}

function normalizeSelectionExplainTerms(input: unknown): SelectionExplainTerm[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((item) => {
      if (typeof item === "string") {
        const normalized = item.trim();
        if (!normalized) {
          return null;
        }
        const parts = normalized.split(/[:：]/).map((entry) => entry.trim()).filter(Boolean);
        if (parts.length < 2) {
          return null;
        }
        return {
          term: parts[0]!,
          explanation: parts.slice(1).join("：")
        };
      }
      if (!item || typeof item !== "object") {
        return null;
      }
      const term = (item as { term?: unknown }).term;
      const explanation = (item as { explanation?: unknown }).explanation;
      if (typeof term !== "string" || typeof explanation !== "string") {
        return null;
      }
      const normalizedTerm = term.trim();
      const normalizedExplanation = explanation.trim();
      if (!normalizedTerm || !normalizedExplanation) {
        return null;
      }
      return {
        term: normalizedTerm,
        explanation: normalizedExplanation
      };
    })
    .filter((item): item is SelectionExplainTerm => Boolean(item));
}

function estimateManualCalloutHeight(
  parsedExplanation: ReturnType<typeof parseManualSelectionExplanation> | null,
  status: ExplainRunStatus,
  collapsed: boolean
) {
  if (!parsedExplanation && status === "running") {
    return 208;
  }
  if (!parsedExplanation && status === "failed") {
    return 142;
  }
  if (!parsedExplanation) {
    return 156;
  }
  if (collapsed) {
    const summaryLen = parsedExplanation.summary.length;
    const keyPointLen = parsedExplanation.keyPoints.join("").length;
    return clampValue(220 + Math.round((summaryLen + keyPointLen) / 34) * 14, 220, 380);
  }
  const base = 360;
  const summaryLen = parsedExplanation.summary.length + parsedExplanation.plainExplanation.length;
  const listCount =
    parsedExplanation.keyPoints.length
    + parsedExplanation.prerequisites.length
    + parsedExplanation.pitfalls.length
    + parsedExplanation.examples.length
    + parsedExplanation.extension.length
    + parsedExplanation.terms.length;
  const termLength = parsedExplanation.terms.reduce(
    (sum, item) => sum + item.term.length + item.explanation.length,
    0
  );
  const listLength =
    parsedExplanation.keyPoints.join("").length
    + parsedExplanation.prerequisites.join("").length
    + parsedExplanation.pitfalls.join("").length
    + parsedExplanation.examples.join("").length
    + parsedExplanation.extension.join("").length;
  const estimated =
    base
    + Math.round(summaryLen / 26) * 14
    + Math.round(listLength / 34) * 10
    + Math.round(termLength / 26) * 10
    + listCount * 28;
  return clampValue(estimated, 420, 920);
}

function renderCalloutList(items: string[], fallbackText: string) {
  if (items.length === 0) {
    return <div className="pdf-highlight-callout-snippet">{fallbackText}</div>;
  }
  return (
    <ul className="pdf-highlight-callout-list">
      {items.map((item, index) => (
        <li key={`${index}-${item}`}>{item}</li>
      ))}
    </ul>
  );
}

function mapConfidenceLabel(confidence: string) {
  if (confidence === "high") {
    return "高可信";
  }
  if (confidence === "low") {
    return "低可信";
  }
  return "中可信";
}

function buildManualCalloutLayoutForPage(
  pageHighlights: ViewerHighlight[],
  collapsedByHighlightId: Record<string, boolean>,
  selectionExplainByHighlightId: Record<string, SelectionPaperExplainResponse>,
  selectionExplainStatusByHighlightId: Record<string, ExplainRunStatus>
) {
  const sorted = [...pageHighlights].sort((a, b) => {
    const topA = getHighlightRectTop(a);
    const topB = getHighlightRectTop(b);
    if (Math.abs(topA - topB) < 1) {
      return a.id.localeCompare(b.id);
    }
    return topA - topB;
  });
  const pageHeight = Math.max(
    720,
    ...sorted.map((item) => getHighlightPageHeight(item))
  );
  const cards = sorted.map((item) => {
    const explain = selectionExplainByHighlightId[item.id];
    const parsed = explain ? parseManualSelectionExplanation(explain) : null;
    const status = selectionExplainStatusByHighlightId[item.id] ?? "idle";
    const collapsed = collapsedByHighlightId[item.id] !== false;
    const height = estimateManualCalloutHeight(parsed, status, collapsed);
    return {
      highlightId: item.id,
      preferredTop: Math.max(8, getHighlightRectTop(item) - 8),
      height
    };
  });
  if (cards.length === 0) {
    return {};
  }
  const availableHeight = Math.max(220, pageHeight - 16);
  const totalHeight = cards.reduce((sum, item) => sum + item.height, 0);
  const baseGap = cards.length > 1
    ? clampValue((availableHeight - totalHeight) / (cards.length - 1), 6, 28)
    : 0;

  const layout: Array<{ highlightId: string; top: number; height: number }> = [];
  let cursorTop = 8;
  for (const card of cards) {
    const top = Math.max(card.preferredTop, cursorTop);
    layout.push({
      highlightId: card.highlightId,
      top,
      height: card.height
    });
    cursorTop = top + card.height + baseGap;
  }

  const pageBottom = pageHeight - 8;
  if (layout.length > 1) {
    const overflow = cursorTop - pageBottom;
    if (overflow > 0) {
      const compactGap = clampValue(baseGap - overflow / (layout.length - 1), 2, baseGap);
      let compactCursor = 8;
      for (const item of layout) {
        item.top = Math.max(compactCursor, item.top - overflow);
        compactCursor = item.top + item.height + compactGap;
      }
    }
  }

  const output: Record<string, { top: number; height: number }> = {};
  let stackCursor = 8;
  for (const item of layout) {
    const adjustedTop = Math.max(item.top, stackCursor);
    output[item.highlightId] = {
      top: adjustedTop,
      height: item.height
    };
    stackCursor = adjustedTop + item.height + 10;
  }
  return output;
}

function getHighlightPageNumber(highlight: ViewerHighlight) {
  const boundingRect = highlight.position?.boundingRect as { pageNumber?: unknown } | undefined;
  if (boundingRect && typeof boundingRect.pageNumber === "number" && Number.isFinite(boundingRect.pageNumber)) {
    return Math.max(1, Math.floor(boundingRect.pageNumber));
  }
  const firstRect = highlight.position?.rects?.[0] as { pageNumber?: unknown } | undefined;
  if (firstRect && typeof firstRect.pageNumber === "number" && Number.isFinite(firstRect.pageNumber)) {
    return Math.max(1, Math.floor(firstRect.pageNumber));
  }
  return 1;
}

function getHighlightPageHeight(highlight: ViewerHighlight) {
  const rect = highlight.position?.boundingRect as { height?: unknown } | undefined;
  const height = rect?.height;
  if (typeof height === "number" && Number.isFinite(height) && height > 0) {
    return height;
  }
  return 0;
}

function getHighlightRectTop(highlight: ViewerHighlight) {
  const rect = highlight.position?.boundingRect as { y1?: unknown; top?: unknown } | undefined;
  const y1 = rect?.y1;
  if (typeof y1 === "number" && Number.isFinite(y1)) {
    return y1;
  }
  const top = rect?.top;
  if (typeof top === "number" && Number.isFinite(top)) {
    return top;
  }
  return 0;
}

function getScaledRectValue(
  rect: Record<string, unknown>,
  keys: string[],
  fallback: number
) {
  for (const key of keys) {
    const value = rect[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return fallback;
}

function getScaledRectDimension(
  rect: Record<string, unknown>,
  directKeys: string[],
  pairKeys: [string, string],
  fallback: number
) {
  const direct = getScaledRectValue(rect, directKeys, Number.NaN);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }
  const start = getScaledRectValue(rect, [pairKeys[0]], Number.NaN);
  const end = getScaledRectValue(rect, [pairKeys[1]], Number.NaN);
  if (Number.isFinite(start) && Number.isFinite(end)) {
    return Math.max(0, end - start);
  }
  return fallback;
}

function safeParseStringList(input: string) {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const list = parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return list.length > 0 ? list : null;
  } catch {
    return null;
  }
}

function readParsedContentString(source: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!source) {
    return null;
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function readParsedContentStringList(source: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!source) {
    return null;
  }
  for (const key of keys) {
    const value = source[key];
    if (!Array.isArray(value)) {
      continue;
    }
    const list = normalizePaperStringList(value);
    if (list.length > 0) {
      return list;
    }
  }
  return null;
}

function normalizePaperStringList(input: unknown[]) {
  return input
    .map((item) => (typeof item === "string" ? item : ""))
    .map((item) => item.trim())
    .filter(Boolean);
}

function toPlainText(content: string) {
  return content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/[#>*_\-\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function estimateChars(content: string) {
  return toPlainText(content).length;
}

function getDocumentDisplayName(document: Document) {
  const rawName = document.title ?? document.sourcePath.split(/[/\\]/).pop() ?? document.sourcePath;
  return rawName.replace(/^[0-9a-f]{8}[-_]/i, "");
}

function formatBlockType(blockType: Block["blockType"]) {
  if (blockType === "section") {
    return "章节";
  }
  if (blockType === "paragraph") {
    return "段落";
  }
  if (blockType === "note") {
    return "笔记";
  }
  return "示例";
}

function inferPageFromBlock(block: Block | null) {
  if (!block) {
    return null;
  }
  const candidates = [
    block.sourceAnchor ?? "",
    ...block.headingPath,
    block.title ?? ""
  ].filter(Boolean);
  for (const candidate of candidates) {
    const page = parsePageNumber(candidate);
    if (page) {
      return page;
    }
  }
  return null;
}

function parsePageNumber(value: string) {
  const normalized = value.trim();
  const zhMatch = normalized.match(/(?:^|[^\d])(\d{1,5})\s*页/);
  if (zhMatch?.[1]) {
    const page = Number.parseInt(zhMatch[1], 10);
    if (Number.isFinite(page) && page > 0) {
      return page;
    }
  }
  const enMatch = normalized.match(/page[-_\s]?(\d{1,5})/i);
  if (enMatch?.[1]) {
    const page = Number.parseInt(enMatch[1], 10);
    if (Number.isFinite(page) && page > 0) {
      return page;
    }
  }
  return null;
}

function decodeBase64ToUint8Array(base64Text: string) {
  const normalized = base64Text.replace(/\s+/g, "");
  const binary = window.atob(normalized);
  const length = binary.length;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
