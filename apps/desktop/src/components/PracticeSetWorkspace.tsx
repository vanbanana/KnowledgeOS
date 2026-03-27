import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Project, StudioArtifact } from "@knowledgeos/shared-types";
import { getStudioArtifact, listStudioArtifacts } from "../lib/commands/client";

interface PracticeSetWorkspaceProps {
  currentProject: Project | null;
  selectedArtifactId: string | null;
  onSelectArtifact: (artifactId: string) => void;
}

interface PracticeSetPreviewPayload {
  practiceSet?: {
    items: Array<{
      type?: string;
      question: string;
      options?: Array<{
        key: string;
        label: string;
      }>;
      answer: string;
      explanation: string;
    }>;
  };
  excerpt?: string;
}

export function PracticeSetWorkspace({
  currentProject,
  selectedArtifactId,
  onSelectArtifact
}: PracticeSetWorkspaceProps) {
  const [selectedAnswers, setSelectedAnswers] = useState<Record<number, string>>({});
  const [revealedQuestions, setRevealedQuestions] = useState<Record<number, boolean>>({});
  const artifactsQuery = useQuery({
    queryKey: ["practice-set-artifacts", currentProject?.projectId],
    queryFn: async () => listStudioArtifacts({ projectId: currentProject!.projectId }),
    enabled: Boolean(currentProject?.projectId)
  });

  const practiceArtifacts = useMemo(
    () => (artifactsQuery.data?.artifacts ?? []).filter((artifact) => artifact.kind === "practice_set"),
    [artifactsQuery.data?.artifacts]
  );

  useEffect(() => {
    if (!selectedArtifactId && practiceArtifacts.length > 0) {
      onSelectArtifact(practiceArtifacts[0].artifactId);
    }
  }, [onSelectArtifact, practiceArtifacts, selectedArtifactId]);

  const selectedArtifact = practiceArtifacts.find((artifact) => artifact.artifactId === selectedArtifactId) ?? practiceArtifacts[0] ?? null;
  const selectedArtifactQuery = useQuery({
    queryKey: ["practice-set-artifact", selectedArtifact?.artifactId],
    queryFn: async () => getStudioArtifact(selectedArtifact!.artifactId),
    enabled: Boolean(selectedArtifact?.artifactId)
  });
  const artifact = selectedArtifactQuery.data?.artifact ?? selectedArtifact;
  const preview = useMemo(() => parsePracticePreview(artifact), [artifact]);
  const items = preview?.practiceSet?.items ?? [];

  useEffect(() => {
    setSelectedAnswers({});
    setRevealedQuestions({});
  }, [artifact?.artifactId]);

  if (!currentProject) {
    return <section className="workspace-generic-empty">先打开项目，再进入练习题工作台。</section>;
  }

  return (
    <section className="workspace-single-surface practice-workspace-grid">
      <section className="workspace-editor studio-artifact-editor">
        <div className="editor-header">
          <div>
            <div className="workspace-panel-title">Practice Set</div>
            <h2>{artifact?.title ?? "练习题工作台"}</h2>
          </div>
          <div className="editor-header-actions">
            {practiceArtifacts.length > 1 ? (
              <select
                className="workspace-inline-select"
                value={artifact?.artifactId ?? ""}
                onChange={(event) => onSelectArtifact(event.target.value)}
              >
                {practiceArtifacts.map((item) => (
                  <option key={item.artifactId} value={item.artifactId}>
                    {item.title}
                  </option>
                ))}
              </select>
            ) : null}
            {items.length > 0 ? <div className="document-status-chip">{items.length} 题</div> : null}
          </div>
        </div>
        {items.length > 0 ? (
          <div className="practice-workspace-list">
            {items.map((item, index) => (
              <article key={`${item.question}-${index}`} className="practice-workspace-card">
                <div className="practice-workspace-order">第 {index + 1} 题</div>
                <div className="practice-workspace-type">{item.type ?? "单选题"}</div>
                <h3>{item.question}</h3>
                {item.options && item.options.length > 0 ? (
                  <div className="practice-option-grid">
                    {item.options.map((option) => {
                      const selected = selectedAnswers[index] === option.key;
                      const revealed = revealedQuestions[index];
                      const correctKey = extractAnswerKey(item.answer);
                      const isCorrect = revealed && option.key === correctKey;
                      const isWrong = revealed && selected && option.key !== correctKey;
                      return (
                        <button
                          key={`${index}-${option.key}`}
                          className={
                            isCorrect
                              ? "practice-option-button practice-option-button-correct"
                              : isWrong
                                ? "practice-option-button practice-option-button-wrong"
                                : selected
                                  ? "practice-option-button practice-option-button-selected"
                                  : "practice-option-button"
                          }
                          onClick={() =>
                            setSelectedAnswers((current) => ({
                              ...current,
                              [index]: option.key
                            }))
                          }
                          disabled={revealed}
                        >
                          <span className="practice-option-key">{option.key}</span>
                          <span>{option.label}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                <div className="practice-action-row">
                  {item.options && item.options.length > 0 ? (
                    <button
                      className="small-button"
                      onClick={() =>
                        setRevealedQuestions((current) => ({
                          ...current,
                          [index]: true
                        }))
                      }
                      disabled={!selectedAnswers[index] || Boolean(revealedQuestions[index])}
                    >
                      提交答案
                    </button>
                  ) : (
                    <button
                      className="small-button"
                      onClick={() =>
                        setRevealedQuestions((current) => ({
                          ...current,
                          [index]: true
                        }))
                      }
                      disabled={Boolean(revealedQuestions[index])}
                    >
                      查看答案
                    </button>
                  )}
                </div>
                {revealedQuestions[index] ? (
                  <div className="practice-result-shell">
                    {item.options && item.options.length > 0 ? (
                      <div className="practice-result-status">
                        {extractAnswerKey(item.answer) === selectedAnswers[index] ? "回答正确" : "回答错误"}
                      </div>
                    ) : null}
                    {item.answer ? (
                      <div className="practice-workspace-answer">
                        <span className="workspace-panel-title">标准答案</span>
                        <p>{item.answer}</p>
                      </div>
                    ) : null}
                    {item.explanation ? (
                      <div className="practice-workspace-explanation">
                        <span className="workspace-panel-title">解析</span>
                        <p>{item.explanation}</p>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <div className="workspace-generic-empty">当前结果还没有可渲染的练习题内容。</div>
        )}
      </section>
    </section>
  );
}

function parsePracticePreview(artifact: StudioArtifact | null): PracticeSetPreviewPayload | null {
  if (!artifact?.previewJson) {
    return null;
  }
  try {
    return JSON.parse(artifact.previewJson) as PracticeSetPreviewPayload;
  } catch {
    return null;
  }
}

function extractAnswerKey(answer: string) {
  const normalized = answer.replace(/^答案[:：]\s*/, "").trim();
  const matched = normalized.match(/[A-D]/);
  return matched?.[0] ?? "";
}
