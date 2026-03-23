import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Project, StudioArtifact } from "@knowledgeos/shared-types";
import { getStudioArtifact, listStudioArtifacts } from "../lib/commands/client";

interface PresentationWorkspaceProps {
  currentProject: Project | null;
  selectedArtifactId: string | null;
  onSelectArtifact: (artifactId: string) => void;
}

interface PresentationPreviewPayload {
  presentation?: {
    slides: Array<{
      title: string;
      lines: string[];
    }>;
  };
}

export function PresentationWorkspace({
  currentProject,
  selectedArtifactId,
  onSelectArtifact
}: PresentationWorkspaceProps) {
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const artifactsQuery = useQuery({
    queryKey: ["presentation-artifacts", currentProject?.projectId],
    queryFn: async () => listStudioArtifacts({ projectId: currentProject!.projectId }),
    enabled: Boolean(currentProject?.projectId)
  });

  const presentationArtifacts = useMemo(
    () => (artifactsQuery.data?.artifacts ?? []).filter((artifact) => artifact.kind === "presentation"),
    [artifactsQuery.data?.artifacts]
  );

  useEffect(() => {
    if (!selectedArtifactId && presentationArtifacts.length > 0) {
      onSelectArtifact(presentationArtifacts[0].artifactId);
    }
  }, [onSelectArtifact, presentationArtifacts, selectedArtifactId]);

  const selectedArtifact = presentationArtifacts.find((artifact) => artifact.artifactId === selectedArtifactId) ?? presentationArtifacts[0] ?? null;
  const selectedArtifactQuery = useQuery({
    queryKey: ["presentation-artifact", selectedArtifact?.artifactId],
    queryFn: async () => getStudioArtifact(selectedArtifact!.artifactId),
    enabled: Boolean(selectedArtifact?.artifactId)
  });
  const artifact = selectedArtifactQuery.data?.artifact ?? selectedArtifact;
  const preview = useMemo(() => parsePresentationPreview(artifact), [artifact]);
  const slides = preview?.presentation?.slides ?? [];
  const activeSlide = slides[activeSlideIndex] ?? slides[0] ?? null;

  useEffect(() => {
    setActiveSlideIndex(0);
  }, [artifact?.artifactId]);

  if (!currentProject) {
    return <section className="workspace-generic-empty">先打开项目，再进入演示文稿工作台。</section>;
  }

  return (
    <section className="workspace-grid presentation-workspace-grid">
      <aside className="workspace-sidepanel">
        <div className="workspace-panel-title">演示结果</div>
        <div className="workspace-list">
          {presentationArtifacts.map((item) => (
            <button
              key={item.artifactId}
              className={item.artifactId === artifact?.artifactId ? "workspace-list-row workspace-list-row-active" : "workspace-list-row"}
              onClick={() => onSelectArtifact(item.artifactId)}
            >
              <strong>{item.title}</strong>
              <span>{item.currentStage ?? "等待查看"}</span>
            </button>
          ))}
          {presentationArtifacts.length === 0 ? <div className="workspace-generic-empty">当前还没有生成演示文稿。</div> : null}
        </div>
      </aside>

      <section className="workspace-editor studio-artifact-editor">
        <div className="editor-header">
          <div>
            <div className="workspace-panel-title">Presentation</div>
            <h2>{artifact?.title ?? "演示文稿工作台"}</h2>
          </div>
          {slides.length > 0 ? <div className="document-status-chip">{slides.length} 页</div> : null}
        </div>
        {activeSlide ? (
          <div className="presentation-workspace-stage">
            <div className="presentation-slide-shell">
              <div className="presentation-slide-order">第 {activeSlideIndex + 1} 页</div>
              <h3>{activeSlide.title}</h3>
              <ul>
                {activeSlide.lines.map((line, index) => (
                  <li key={`${line}-${index}`}>{line.replace(/^[-*]\s*/, "")}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <div className="workspace-generic-empty">当前结果还没有可渲染的演示文稿内容。</div>
        )}
      </section>

      <aside className="workspace-preview">
        <div className="workspace-panel-title">幻灯片目录</div>
        <div className="workspace-list">
          {slides.map((slide, index) => (
            <button
              key={`${slide.title}-${index}`}
              className={index === activeSlideIndex ? "workspace-list-row workspace-list-row-active" : "workspace-list-row"}
              onClick={() => setActiveSlideIndex(index)}
            >
              <strong>{slide.title}</strong>
              <span>第 {index + 1} 页</span>
            </button>
          ))}
          {slides.length === 0 ? <div className="workspace-generic-empty">当前没有幻灯片目录。</div> : null}
        </div>
      </aside>
    </section>
  );
}

function parsePresentationPreview(artifact: StudioArtifact | null): PresentationPreviewPayload | null {
  if (!artifact?.previewJson) {
    return null;
  }
  try {
    return JSON.parse(artifact.previewJson) as PresentationPreviewPayload;
  } catch {
    return null;
  }
}
