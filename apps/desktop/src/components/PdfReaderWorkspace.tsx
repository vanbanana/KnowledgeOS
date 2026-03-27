import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
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
import { explainBlock, listBlocks, listDocumentBlockExplanations } from "../lib/commands/client";
import { MarkdownArticle } from "./MarkdownArticle";

interface PdfReaderWorkspaceProps {
  currentProject: Project | null;
  documents: Document[];
  currentDocument: Document | null;
  onSelectDocument: (documentId: string | null) => void;
  bootstrapBlocks: Block[];
  onOpenGraphView: () => void;
}

interface DocumentPdfBytesResponse {
  base64Data: string;
  byteLen: number;
}

export function PdfReaderWorkspace({
  currentProject,
  documents,
  currentDocument,
  onSelectDocument,
  bootstrapBlocks,
  onOpenGraphView
}: PdfReaderWorkspaceProps) {
  const queryClient = useQueryClient();
  const highlighterUtilsRef = useRef<PdfHighlighterUtils | null>(null);

  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [viewerHighlights, setViewerHighlights] = useState<ViewerHighlight[]>([]);
  const [loadedPdfDocument, setLoadedPdfDocument] = useState<any>(null);
  const [localExplanations, setLocalExplanations] = useState<Record<string, BlockExplanation>>({});
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [pdfState, setPdfState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [pdfMessage, setPdfMessage] = useState<string | null>(null);
  const [boxSelectMode, setBoxSelectMode] = useState(true);
  const [autoBlockMode, setAutoBlockMode] = useState(false);

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

  const explanationsQuery = useQuery({
    queryKey: ["document-paper-explanations", currentDocument?.documentId],
    queryFn: async () => listDocumentBlockExplanations({
      documentId: currentDocument!.documentId,
      mode: "paper"
    }),
    enabled: Boolean(currentDocument?.documentId)
  });

  const blocks = blocksQuery.data?.blocks ?? [];
  const hasBackendBlocks = blocks.length > 0;
  const isPreviewHighlightMode = autoBlockMode && !hasBackendBlocks;
  const sourceModeLabel = autoBlockMode
    ? (isPreviewHighlightMode ? "自动预览块（前端）" : "自动映射块（后端）")
    : "手动框选块";
  const explanationMap = useMemo(() => {
    const map = new Map<string, BlockExplanation>();
    for (const explanation of explanationsQuery.data?.explanations ?? []) {
      if (!map.has(explanation.blockId)) {
        map.set(explanation.blockId, explanation);
      }
    }
    for (const [blockId, explanation] of Object.entries(localExplanations)) {
      map.set(blockId, explanation);
    }
    return map;
  }, [explanationsQuery.data?.explanations, localExplanations]);

  const selectedBlock = blocks.find((block) => block.blockId === selectedBlockId) ?? null;
  const selectedExplanation = selectedBlock ? explanationMap.get(selectedBlock.blockId) ?? null : null;
  const selectedViewerHighlight = useMemo(
    () => viewerHighlights.find((item) => item.blockId === selectedBlockId || item.id === selectedBlockId) ?? null,
    [selectedBlockId, viewerHighlights]
  );
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
    if (hasBackendBlocks && (!selectedBlockId || !blocks.some((block) => block.blockId === selectedBlockId))) {
      setSelectedBlockId(blocks[0]!.blockId);
      return;
    }
    if (!hasBackendBlocks && selectedBlockId) {
      setSelectedBlockId(null);
    }
  }, [blocks, hasBackendBlocks, selectedBlockId, viewerHighlights]);

  useEffect(() => {
    setLocalExplanations({});
    setPdfData(null);
    setViewerHighlights([]);
    setLoadedPdfDocument(null);
    setPdfState("idle");
    setPdfMessage(null);
    highlighterUtilsRef.current = null;
  }, [currentDocument?.documentId]);

  useEffect(() => {
    if (autoBlockMode) {
      return;
    }
    setViewerHighlights((current) =>
      current.filter((item) => !item.id.startsWith("gen-") && !item.id.startsWith("auto-"))
    );
  }, [autoBlockMode]);

  useEffect(() => {
    let cancelled = false;
    async function buildAutoHighlights() {
      if (!autoBlockMode || !loadedPdfDocument || blocks.length === 0) {
        return;
      }
      const generated = await generateAutoHighlightsFromBlocks(loadedPdfDocument, blocks);
      if (cancelled) {
        return;
      }
      setViewerHighlights((current) => {
        const manual = current.filter(
          (item) => !item.id.startsWith("auto-") && !item.id.startsWith("gen-")
        );
        const map = new Map<string, ViewerHighlight>();
        for (const item of manual) {
          map.set(item.id, item);
        }
        for (const item of generated) {
          map.set(item.id, item);
        }
        return Array.from(map.values());
      });
    }
    void buildAutoHighlights();
    return () => {
      cancelled = true;
    };
  }, [autoBlockMode, blocks, loadedPdfDocument]);

  useEffect(() => {
    let cancelled = false;
    async function buildPreviewHighlights() {
      if (!autoBlockMode || !loadedPdfDocument || blocks.length > 0) {
        return;
      }
      const totalPages = Math.max(1, loadedPdfDocument.numPages || 1);
      const generated: ViewerHighlight[] = [];
      for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
        if (cancelled) {
          return;
        }
        const pageHighlights = await generatePreviewHighlightsForPage(loadedPdfDocument, pageNumber);
        generated.push(...pageHighlights);
        if (pageNumber <= 6 || pageNumber % 4 === 0 || pageNumber === totalPages) {
          setViewerHighlights((current) => {
            const manual = current.filter((item) => !item.id.startsWith("gen-") && !item.id.startsWith("auto-"));
            return [...manual, ...generated];
          });
        }
        if (pageNumber % 3 === 0) {
          await new Promise<void>((resolve) => {
            window.setTimeout(() => resolve(), 0);
          });
        }
      }
    }
    void buildPreviewHighlights();
    return () => {
      cancelled = true;
    };
  }, [autoBlockMode, blocks.length, loadedPdfDocument]);

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
    if (!boxSelectMode) {
      return;
    }
    const selectedText = selection.content.text?.trim() ?? "";
    if (!selectedText) {
      return;
    }
    const matchedBlock = findBestMatchedBlock(selectedText, blocks);
    const manualId = matchedBlock
      ? `manual-block-${matchedBlock.blockId}`
      : `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const matchedInfo = matchedBlock ? blockLookup.get(matchedBlock.blockId) : null;
    const nextHighlight: ViewerHighlight = {
      id: manualId,
      type: "text",
      position: selection.position,
      content: {
        text: selectedText
      },
      blockId: matchedBlock?.blockId,
      label: matchedInfo?.title ?? "手动选择",
      snippet: selectedText.slice(0, 60),
      detail: selectedText
    };
    setViewerHighlights((current) => {
      const manualOnly = current.filter((item) => item.id.startsWith("manual-"));
      if (matchedBlock) {
        const filtered = manualOnly.filter((item) => item.blockId !== matchedBlock.blockId);
        return [...filtered, nextHighlight].slice(-12);
      }
      return [...manualOnly, nextHighlight].slice(-12);
    });
    setSelectedBlockId(matchedBlock?.blockId ?? manualId);
    highlighterUtilsRef.current?.removeGhostHighlight();
    // 清理浏览器原生选区，避免松手后蓝色选中残留
    const clearNativeSelection = () => {
      window.getSelection()?.removeAllRanges();
    };
    clearNativeSelection();
    window.setTimeout(clearNativeSelection, 0);
    window.setTimeout(clearNativeSelection, 40);
  }

  const explainMutation = useMutation({
    mutationFn: explainBlock,
    onSuccess: async (result) => {
      setLocalExplanations((current) => ({
        ...current,
        [result.explanation.blockId]: result.explanation
      }));
      await queryClient.invalidateQueries({ queryKey: ["document-paper-explanations", currentDocument?.documentId] });
    }
  });

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
    <section className="pdf-reader-shell">
      <div className="pdf-reader-toolbar">
        <div className="pdf-reader-title">{getDocumentDisplayName(currentDocument)}</div>
        <div className="pdf-reader-actions">
          <span className={isPreviewHighlightMode ? "pdf-source-chip pdf-source-chip-preview" : "pdf-source-chip"}>
            {sourceModeLabel}
          </span>
          <button
            className={autoBlockMode ? "small-button small-button-active" : "small-button"}
            onClick={() => setAutoBlockMode((current) => !current)}
          >
            {autoBlockMode ? "自动块开启" : "自动块关闭"}
          </button>
          <button
            className={boxSelectMode ? "small-button small-button-active" : "small-button"}
            onClick={() => setBoxSelectMode((current) => !current)}
          >
            {boxSelectMode ? "原文框选中" : "原文框选"}
          </button>
          <button className="small-button" onClick={() => onSelectDocument(currentDocument.documentId)}>定位当前文档</button>
          <button className="small-button" onClick={onOpenGraphView}>打开图谱</button>
        </div>
      </div>
      {!["chunked", "indexed", "ready"].includes(currentDocument.parseStatus) ? (
        <div className="pdf-reader-status-hint">
          正在后台解析：{currentDocument.parseStatus}。你可以先阅读原始 PDF，分块会实时出现。
        </div>
      ) : null}

      <div className="pdf-reader-grid pdf-reader-grid-no-sidebar">
        <section className="pdf-preview-pane pdf-preview-pane-main">
          <div className="pdf-pane-header">原文 PDF（单界面）</div>
          {pdfState === "failed" ? (
            <div className="surface-empty">{pdfMessage ?? "PDF 预览失败。"}</div>
          ) : (
            <>
              <div className="pdf-preview-toolbar">
                <div className="pdf-preview-page-label">直接在正文拖拽选择文本，块信息已集成到 PDF 画面内</div>
              </div>
              <div className="pdf-preview-viewport">
                {pdfState !== "ready" || !pdfDocumentConfig ? (
                  <div className="pdf-preview-status">{pdfMessage ?? "正在准备 PDF…"}</div>
                ) : (
                  <div className="pdf-highlighter-shell pdf-highlighter-shell-single">
                    <PdfLoader document={pdfDocumentConfig} workerSrc={pdfWorkerUrl}>
                      {(pdfDocument) => (
                        <>
                          <PdfDocumentBinder
                            pdfDocument={pdfDocument}
                            onReady={setLoadedPdfDocument}
                          />
                          <PdfHighlighter
                            pdfDocument={pdfDocument}
                            highlights={viewerHighlights}
                            enableAreaSelection={() => false}
                            onSelection={boxSelectMode ? handlePdfSelection : undefined}
                            textSelectionColor={boxSelectMode ? "rgba(122, 162, 255, 0.35)" : "rgba(120, 180, 255, 0.12)"}
                            utilsRef={(utils) => {
                              highlighterUtilsRef.current = utils;
                            }}
                          >
                            <PdfBlockHighlightContainer
                              selectedBlockId={selectedBlockId}
                              onSelectBlock={handleSelectBlock}
                              blockLookup={blockLookup}
                            />
                          </PdfHighlighter>
                        </>
                      )}
                    </PdfLoader>

                    <div className="pdf-floating-status">
                      {!autoBlockMode
                        ? (viewerHighlights.length > 0
                          ? `手动框选模式：已选择 ${viewerHighlights.length} 个文本块`
                          : "手动框选模式：拖拽选择文本后才会显示块")
                        : (viewerHighlights.length > 0
                          ? (isPreviewHighlightMode
                            ? `自动预览模式：已生成 ${viewerHighlights.length} 个预览块`
                            : `自动映射模式：已生成 ${viewerHighlights.length} 个可定位块`)
                          : (isPreviewHighlightMode
                            ? "自动预览模式：正在生成预览块..."
                            : "自动映射模式：正在加载后端块..."))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </section>
  );
}

interface ViewerHighlight extends Highlight {
  blockId?: string;
  label?: string;
  snippet?: string;
  detail?: string;
}

function PdfDocumentBinder({
  pdfDocument,
  onReady
}: {
  pdfDocument: any;
  onReady: (pdfDocument: any) => void;
}) {
  useEffect(() => {
    onReady(pdfDocument);
  }, [onReady, pdfDocument]);
  return null;
}

function PdfBlockHighlightContainer({
  selectedBlockId,
  onSelectBlock,
  blockLookup
}: {
  selectedBlockId: string | null;
  onSelectBlock: (blockId: string) => void;
  blockLookup: Map<string, { title: string; snippet: string }>;
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
  const calloutTitle = blockInfo?.title || highlight.label || "自动生成块";
  const calloutSnippetRaw = blockInfo?.snippet || highlight.snippet || highlight.content?.text || "自动匹配结果";
  const calloutSnippet = calloutSnippetRaw.slice(0, 34);
  const highlightKey = highlight.blockId ?? highlight.id;
  const textLayer = highlightBindings.textLayer;
  const layerWidth = textLayer.clientWidth || 0;
  const layerHeight = textLayer.clientHeight || 0;
  const rect = highlight.position.boundingRect;
  const cardWidth = 230;
  const cardHeight = 58;
  const cardLeft = layerWidth + 54;
  const cardTop = clampValue(rect.top - 6, 8, Math.max(8, layerHeight - cardHeight - 8));
  const anchorX = rect.left + rect.width;
  const anchorY = rect.top + rect.height / 2;
  const connectorX = cardLeft - 10;
  const connectorY = cardTop + cardHeight / 2;
  const frameLeft = Math.max(0, rect.left - 2);
  const frameTop = Math.max(0, rect.top - 2);
  const frameWidth = Math.max(0, rect.width + 4);
  const frameHeight = Math.max(0, rect.height + 4);

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
          className={isHovering ? "pdf-highlight-flow-frame pdf-highlight-flow-frame-visible" : "pdf-highlight-flow-frame"}
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
          <button
            className={active ? "pdf-highlight-callout pdf-highlight-callout-active" : "pdf-highlight-callout"}
            style={{
              left: `${cardLeft}px`,
              top: `${cardTop}px`,
              width: `${cardWidth}px`,
              height: `${cardHeight}px`
            }}
            onClick={() => onSelectBlock(highlightKey)}
          >
            <div className="pdf-highlight-callout-title">{calloutTitle}</div>
            <div className="pdf-highlight-callout-snippet">{calloutSnippet}</div>
          </button>
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
  if (!best || best.score < 0.16) {
    return null;
  }
  return best.block;
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
    };
  } catch {
    return null;
  }
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
