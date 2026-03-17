import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Card, Project } from "@knowledgeos/shared-types";
import { listCards, updateCard } from "../lib/commands/client";
import { MarkdownArticle } from "./MarkdownArticle";

interface CardsWorkspaceProps {
  currentProject: Project | null;
}

export function CardsWorkspace({ currentProject }: CardsWorkspaceProps) {
  const queryClient = useQueryClient();
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [draftTags, setDraftTags] = useState("");

  const cardsQuery = useQuery({
    queryKey: ["cards", currentProject?.projectId],
    queryFn: async () => listCards(currentProject!.projectId),
    enabled: Boolean(currentProject?.projectId)
  });

  const cards = cardsQuery.data?.cards ?? [];
  const currentCard = useMemo(
    () => cards.find((item) => item.cardId === selectedCardId) ?? cards[0] ?? null,
    [cards, selectedCardId]
  );

  useEffect(() => {
    if (!currentCard) {
      setDraftTitle("");
      setDraftContent("");
      setDraftTags("");
      return;
    }
    setDraftTitle(currentCard.title);
    setDraftContent(currentCard.contentMd);
    setDraftTags(parseTags(currentCard).join(", "));
    if (currentCard.cardId !== selectedCardId) {
      setSelectedCardId(currentCard.cardId);
    }
  }, [currentCard, selectedCardId]);

  const updateCardMutation = useMutation({
    mutationFn: updateCard,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["cards", currentProject?.projectId] });
    }
  });

  if (!currentProject) {
    return <section className="workspace-generic-empty">先选择项目，再进入卡片库。</section>;
  }

  return (
    <section className="workspace-grid">
      <aside className="workspace-sidepanel">
        <div className="workspace-panel-title">卡片列表</div>
        <div className="workspace-list">
          {cards.length === 0 ? <div className="empty-hint">当前项目还没有卡片。先在阅读器里生成卡片。</div> : null}
          {cards.map((card) => (
            <button
              key={card.cardId}
              className={card.cardId === currentCard?.cardId ? "workspace-list-row workspace-list-row-active" : "workspace-list-row"}
              onClick={() => setSelectedCardId(card.cardId)}
            >
              <strong>{card.title}</strong>
              <span>{parseTags(card).join(" / ") || "未打标签"}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="workspace-editor">
        {currentCard ? (
          <>
            <div className="editor-header">
              <div>
                <div className="workspace-kicker">CARDS</div>
                <h2>{currentCard.title}</h2>
              </div>
              <button
                className="gold-button"
                disabled={updateCardMutation.isPending}
                onClick={() =>
                  updateCardMutation.mutate({
                    cardId: currentCard.cardId,
                    title: draftTitle,
                    contentMd: draftContent,
                    tags: splitTags(draftTags)
                  })
                }
              >
                保存卡片
              </button>
            </div>

            <label className="field-stack">
              <span>标题</span>
              <input className="plain-input" value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} />
            </label>

            <label className="field-stack">
              <span>标签</span>
              <input className="plain-input" value={draftTags} onChange={(event) => setDraftTags(event.target.value)} />
            </label>

            <label className="field-stack field-stack-grow">
              <span>内容</span>
              <textarea
                className="note-editor card-editor"
                value={draftContent}
                onChange={(event) => setDraftContent(event.target.value)}
              />
            </label>
          </>
        ) : (
          <div className="workspace-generic-empty">当前没有可编辑卡片。</div>
        )}
      </section>

      <aside className="workspace-preview">
        <div className="workspace-panel-title">卡片预览</div>
        {currentCard ? <MarkdownArticle content={draftContent} /> : <div className="empty-hint">选择一张卡片后可在这里预览。</div>}
      </aside>
    </section>
  );
}

function parseTags(card: Card) {
  try {
    return JSON.parse(card.tagsJson) as string[];
  } catch {
    return [];
  }
}

function splitTags(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
