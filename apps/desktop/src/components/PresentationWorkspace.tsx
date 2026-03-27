import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
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
  const outputPath = artifact?.outputPath ?? null;
  const isRealPptx = Boolean(outputPath && outputPath.toLowerCase().endsWith(".pptx"));

  useEffect(() => {
    setActiveSlideIndex(0);
  }, [artifact?.artifactId]);

  if (!currentProject) {
    return <section className="workspace-generic-empty">先打开项目，再进入演示文稿工作台。</section>;
  }

  return (
    <section className="workspace-single-surface presentation-workspace-grid">
      <section className="workspace-editor studio-artifact-editor">
        <div className="editor-header">
          <div>
            <div className="workspace-panel-title">Presentation</div>
            <h2>{artifact?.title ?? "演示文稿工作台"}</h2>
            {isRealPptx ? <p className="presentation-workspace-hint">当前画面是内容预览，点击右侧按钮可直接打开真实 PPTX 文件。</p> : null}
          </div>
          <div className="editor-header-actions">
            {presentationArtifacts.length > 1 ? (
              <select
                className="workspace-inline-select"
                value={artifact?.artifactId ?? ""}
                onChange={(event) => onSelectArtifact(event.target.value)}
              >
                {presentationArtifacts.map((item) => (
                  <option key={item.artifactId} value={item.artifactId}>
                    {item.title}
                  </option>
                ))}
              </select>
            ) : null}
            {isRealPptx ? (
              <button
                className="small-button presentation-open-button"
                onClick={async () => {
                  await invoke("open_path_command", { payload: { path: outputPath } });
                }}
              >
                打开 PPTX
              </button>
            ) : null}
            {slides.length > 0 ? <div className="document-status-chip">{slides.length} 页</div> : null}
          </div>
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
