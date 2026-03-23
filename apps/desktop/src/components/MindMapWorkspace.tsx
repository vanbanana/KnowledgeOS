import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Transformer } from "markmap-lib";
import { Markmap } from "markmap-view";
import type { Project, StudioArtifact } from "@knowledgeos/shared-types";
import { getStudioArtifact, listStudioArtifacts } from "../lib/commands/client";

interface MindMapWorkspaceProps {
  currentProject: Project | null;
  selectedArtifactId: string | null;
  onSelectArtifact: (artifactId: string) => void;
}

interface MindMapPreviewPayload {
  mindMap?: {
    nodes: Array<{
      depth: number;
      label: string;
    }>;
  };
}

const transformer = new Transformer();

export function MindMapWorkspace({
  currentProject,
  selectedArtifactId,
  onSelectArtifact
}: MindMapWorkspaceProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const markmapRef = useRef<Markmap | null>(null);

  const artifactsQuery = useQuery({
    queryKey: ["mind-map-artifacts", currentProject?.projectId],
    queryFn: async () => listStudioArtifacts({ projectId: currentProject!.projectId }),
    enabled: Boolean(currentProject?.projectId)
  });

  const mindMapArtifacts = useMemo(
    () => (artifactsQuery.data?.artifacts ?? []).filter((artifact) => artifact.kind === "mind_map"),
    [artifactsQuery.data?.artifacts]
  );

  useEffect(() => {
    if (!selectedArtifactId && mindMapArtifacts.length > 0) {
      onSelectArtifact(mindMapArtifacts[0].artifactId);
    }
  }, [mindMapArtifacts, onSelectArtifact, selectedArtifactId]);

  const selectedArtifact = mindMapArtifacts.find((artifact) => artifact.artifactId === selectedArtifactId) ?? mindMapArtifacts[0] ?? null;
  const selectedArtifactQuery = useQuery({
    queryKey: ["mind-map-artifact", selectedArtifact?.artifactId],
    queryFn: async () => getStudioArtifact(selectedArtifact!.artifactId),
    enabled: Boolean(selectedArtifact?.artifactId)
  });

  const artifact = selectedArtifactQuery.data?.artifact ?? selectedArtifact;
  const preview = useMemo(() => parseMindMapPreview(artifact), [artifact]);
  const markdown = useMemo(() => buildMindMapMarkdown(artifact?.title ?? "思维导图", preview?.mindMap?.nodes ?? []), [artifact?.title, preview?.mindMap?.nodes]);
  const nodeCount = preview?.mindMap?.nodes.length ?? 0;

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || nodeCount === 0) {
      return;
    }

    svg.innerHTML = "";
    const { root } = transformer.transform(markdown);
    const mm = Markmap.create(svg, {
      autoFit: true,
      duration: 320,
      fitRatio: 0.9,
      maxInitialScale: 1.1,
      pan: true,
      zoom: true
    }, root);
    markmapRef.current = mm;

    window.requestAnimationFrame(() => {
      mm.fit();
    });

    return () => {
      markmapRef.current?.destroy();
      markmapRef.current = null;
    };
  }, [markdown, nodeCount]);

  if (!currentProject) {
    return <section className="workspace-generic-empty">先打开项目，再进入思维导图工作台。</section>;
  }

  return (
    <section className="workspace-grid mind-map-workspace-grid">
      <aside className="workspace-sidepanel">
        <div className="workspace-panel-title">思维导图结果</div>
        <div className="workspace-list">
          {mindMapArtifacts.map((item) => (
            <button
              key={item.artifactId}
              className={item.artifactId === artifact?.artifactId ? "workspace-list-row workspace-list-row-active" : "workspace-list-row"}
              onClick={() => onSelectArtifact(item.artifactId)}
            >
              <strong>{item.title}</strong>
              <span>{item.currentStage ?? "等待查看"}</span>
            </button>
          ))}
          {mindMapArtifacts.length === 0 ? <div className="workspace-generic-empty">当前还没有生成思维导图。</div> : null}
        </div>
      </aside>

      <section className="workspace-editor studio-artifact-editor">
        <div className="editor-header">
          <div>
            <div className="workspace-panel-title">Mind Map</div>
            <h2>{artifact?.title ?? "思维导图工作台"}</h2>
          </div>
          {nodeCount > 0 ? <div className="document-status-chip">{nodeCount} 个节点</div> : null}
        </div>
        {nodeCount > 0 ? (
          <div className="mind-map-markmap-shell">
            <svg ref={svgRef} className="mind-map-markmap-svg" aria-label="思维导图画布" />
          </div>
        ) : (
          <div className="workspace-generic-empty">当前结果还没有可渲染的思维导图内容。</div>
        )}
      </section>
    </section>
  );
}

function parseMindMapPreview(artifact: StudioArtifact | null): MindMapPreviewPayload | null {
  if (!artifact?.previewJson) {
    return null;
  }
  try {
    return JSON.parse(artifact.previewJson) as MindMapPreviewPayload;
  } catch {
    return null;
  }
}

function buildMindMapMarkdown(title: string, nodes: Array<{ depth: number; label: string }>) {
  const lines = [`# ${title}`];
  const filtered = nodes.filter((node) => node.label.trim().length > 0);
  const offset = filtered.length > 0 && filtered[0].depth === 0 ? 1 : 0;

  filtered.forEach((node, index) => {
    if (index === 0 && node.depth === 0) {
      if (node.label !== title) {
        lines[0] = `# ${node.label}`;
      }
      return;
    }
    const depth = Math.max(2, node.depth + 2 - offset);
    lines.push(`${"#".repeat(depth)} ${node.label}`);
  });

  return lines.join("\n");
}
