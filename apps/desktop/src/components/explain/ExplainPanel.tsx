import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Block, BlockExplanation } from "@knowledgeos/shared-types";
import { explainBlock, listBlockExplanations, regenerateBlockExplanation, saveCard } from "../../lib/commands/client";

interface ExplainPanelProps {
  currentBlock: Block | null;
}

const explainModes = [
  { value: "default", label: "标准解释" },
  { value: "intro", label: "入门解释" },
  { value: "exam", label: "考试视角" },
  { value: "research", label: "科研视角" }
];

export function ExplainPanel({ currentBlock }: ExplainPanelProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState("default");
  const [feedback, setFeedback] = useState<string | null>(null);

  const explanationsQuery = useQuery({
    queryKey: ["block-explanations", currentBlock?.blockId],
    queryFn: async () => listBlockExplanations(currentBlock!.blockId),
    enabled: Boolean(currentBlock?.blockId)
  });

  const explainMutation = useMutation({
    mutationFn: explainBlock,
    onSuccess: async () => {
      setFeedback("解释已生成。");
      await queryClient.invalidateQueries({ queryKey: ["block-explanations", currentBlock?.blockId] });
    },
    onError: (error: Error) => {
      setFeedback(error.message);
    }
  });

  const regenerateMutation = useMutation({
    mutationFn: regenerateBlockExplanation,
    onSuccess: async () => {
      setFeedback("解释已重新生成。");
      await queryClient.invalidateQueries({ queryKey: ["block-explanations", currentBlock?.blockId] });
    },
    onError: (error: Error) => {
      setFeedback(error.message);
    }
  });

  const saveCardMutation = useMutation({
    mutationFn: saveCard,
    onSuccess: () => {
      setFeedback("已保存为卡片。");
    },
    onError: (error: Error) => {
      setFeedback(error.message);
    }
  });

  const currentExplanation = useMemo(() => {
    const items = explanationsQuery.data?.explanations ?? [];
    return items.find((item) => item.mode === mode) ?? items[0] ?? null;
  }, [explanationsQuery.data?.explanations, mode]);

  const parsed = useMemo(() => parseExplanation(currentExplanation), [currentExplanation]);

  if (!currentBlock) {
    return <div className="chat-card"><p>先在中间选择一个知识块，再生成解释。</p></div>;
  }

  return (
    <div className="explain-panel">
      <div className="chat-section">
        <div className="chat-section-title">Explain</div>
        <div className="mode-chip-row">
          {explainModes.map((item) => (
            <button
              key={item.value}
              className={item.value === mode ? "mode-chip mode-chip-active" : "mode-chip"}
              onClick={() => setMode(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="explain-action-row">
          <button
            className="quick-button"
            disabled={explainMutation.isPending}
            onClick={() => explainMutation.mutate({ blockId: currentBlock.blockId, mode })}
          >
            生成解释
          </button>
          <button
            className="quick-button"
            disabled={regenerateMutation.isPending}
            onClick={() => regenerateMutation.mutate({ blockId: currentBlock.blockId, mode })}
          >
            重新生成
          </button>
          <button
            className="quick-button"
            disabled={saveCardMutation.isPending}
            onClick={() =>
              saveCardMutation.mutate({
                sourceBlockId: currentBlock.blockId,
                title: currentBlock.title ?? undefined,
                tags: [mode]
              })
            }
          >
            生成卡片
          </button>
        </div>
        {feedback ? <div className="inline-feedback">{feedback}</div> : null}
      </div>

      {explainMutation.isPending || regenerateMutation.isPending ? (
        <div className="chat-card">
          <div className="chat-card-title">正在生成解释</div>
          <p>模型正在基于当前知识块整理结构化 explanation。</p>
        </div>
      ) : null}

      {explanationsQuery.isError ? (
        <div className="chat-card">
          <div className="chat-card-title">读取解释失败</div>
          <p>{explanationsQuery.error.message}</p>
        </div>
      ) : null}

      {currentExplanation ? (
        <>
          <div className="chat-card">
            <div className="chat-card-title">摘要</div>
            <p>{currentExplanation.summary}</p>
          </div>

          <div className="chat-section">
            <div className="chat-section-title">核心概念</div>
            <div className="fact-list">
              {parsed.keyConcepts.length === 0 ? <p>当前模式还没有概念条目。</p> : null}
              {parsed.keyConcepts.map((item) => (
                <div key={item.term} className="fact-item">
                  <strong>{item.term}</strong>
                  <p>{item.explanation}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="chat-section">
            <div className="chat-section-title">前置知识</div>
            <ListBlock values={parsed.prerequisites} emptyText="当前没有记录前置知识。" />
          </div>

          <div className="chat-section">
            <div className="chat-section-title">易错点</div>
            <ListBlock values={parsed.pitfalls} emptyText="当前没有记录易错点。" />
          </div>

          <div className="chat-section">
            <div className="chat-section-title">示例</div>
            <ListBlock values={parsed.examples} emptyText="当前没有生成示例。" />
          </div>
        </>
      ) : (
        <div className="chat-card">
          <div className="chat-card-title">还没有 explanation</div>
          <p>右侧面板现在已经接上 Explain Service。点击上方按钮即可生成并缓存块级解释。</p>
        </div>
      )}
    </div>
  );
}

function parseExplanation(explanation: BlockExplanation | null) {
  if (!explanation) {
    return {
      keyConcepts: [] as Array<{ term: string; explanation: string }>,
      prerequisites: [] as string[],
      pitfalls: [] as string[],
      examples: [] as string[]
    };
  }

  return {
    keyConcepts: safeJsonParse<Array<{ term: string; explanation: string }>>(explanation.keyConceptsJson, []),
    prerequisites: safeJsonParse<string[]>(explanation.prerequisitesJson, []),
    pitfalls: safeJsonParse<string[]>(explanation.pitfallsJson, []),
    examples: safeJsonParse<string[]>(explanation.examplesJson, [])
  };
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function ListBlock({ values, emptyText }: { values: string[]; emptyText: string }) {
  if (values.length === 0) {
    return <p>{emptyText}</p>;
  }
  return (
    <ul className="chat-list">
      {values.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}
