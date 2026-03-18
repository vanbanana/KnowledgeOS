import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentTask, Project } from "@knowledgeos/shared-types";
import {
  confirmAgentTask,
  generateAgentPreview,
  getAgentAudit,
  listAgentTasks,
  planAgentTask,
  rollbackAgentTask
} from "../lib/commands/client";

interface AgentWorkspaceProps {
  currentProject: Project | null;
}

export function AgentWorkspace({ currentProject }: AgentWorkspaceProps) {
  const queryClient = useQueryClient();
  const [taskText, setTaskText] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const tasksQuery = useQuery({
    queryKey: ["agent-tasks", currentProject?.projectId],
    queryFn: async () => listAgentTasks({ projectId: currentProject!.projectId }),
    enabled: Boolean(currentProject?.projectId)
  });

  const tasks = tasksQuery.data?.tasks ?? [];
  const currentTask = useMemo(
    () => tasks.find((item) => item.taskId === selectedTaskId) ?? tasks[0] ?? null,
    [tasks, selectedTaskId]
  );

  useEffect(() => {
    if (currentTask && currentTask.taskId !== selectedTaskId) {
      setSelectedTaskId(currentTask.taskId);
    }
  }, [currentTask, selectedTaskId]);

  const auditQuery = useQuery({
    queryKey: ["agent-audit", currentTask?.taskId],
    queryFn: async () => getAgentAudit(currentTask!.taskId),
    enabled: Boolean(currentTask?.taskId)
  });

  const planMutation = useMutation({
    mutationFn: planAgentTask,
    onSuccess: async (result) => {
      setSelectedTaskId(result.task.taskId);
      setTaskText("");
      await queryClient.invalidateQueries({ queryKey: ["agent-tasks", currentProject?.projectId] });
    }
  });

  const previewMutation = useMutation({
    mutationFn: generateAgentPreview,
    onSuccess: async (result) => {
      setSelectedTaskId(result.task.taskId);
      await queryClient.invalidateQueries({ queryKey: ["agent-tasks", currentProject?.projectId] });
      await queryClient.invalidateQueries({ queryKey: ["agent-audit", result.task.taskId] });
    }
  });

  const confirmMutation = useMutation({
    mutationFn: confirmAgentTask,
    onSuccess: async (result) => {
      setSelectedTaskId(result.task.taskId);
      await queryClient.invalidateQueries({ queryKey: ["agent-tasks", currentProject?.projectId] });
      await queryClient.invalidateQueries({ queryKey: ["agent-audit", result.task.taskId] });
    }
  });

  const rollbackMutation = useMutation({
    mutationFn: rollbackAgentTask,
    onSuccess: async (result) => {
      setSelectedTaskId(result.task.taskId);
      await queryClient.invalidateQueries({ queryKey: ["agent-tasks", currentProject?.projectId] });
      await queryClient.invalidateQueries({ queryKey: ["agent-audit", result.task.taskId] });
    }
  });

  if (!currentProject) {
    return <section className="workspace-generic-empty">先选择项目，再进入 Agent 控制台。</section>;
  }

  const currentPlan = currentTask?.planJson ? safeParse(currentTask.planJson) : null;
  const currentPreview = currentTask?.previewJson ? safeParse(currentTask.previewJson) : null;
  const currentAudit = auditQuery.data ?? null;

  return (
    <section className="workspace-grid agent-workspace-grid">
      <aside className="workspace-sidepanel">
        <div className="workspace-panel-title">新建 Agent 任务</div>
        <textarea
          className="note-editor agent-task-input"
          value={taskText}
          onChange={(event) => setTaskText(event.target.value)}
          placeholder="例如：把项目里重复的 README 卡片合并，并补上关系。"
        />
        <button
          className="gold-button"
          disabled={!taskText.trim() || planMutation.isPending}
          onClick={() =>
            planMutation.mutate({
              projectId: currentProject.projectId,
              taskText: taskText.trim()
            })
          }
        >
          生成计划
        </button>

        <div className="workspace-panel-title">任务列表</div>
        <div className="workspace-list">
          {tasks.length === 0 ? <div className="empty-hint">当前项目还没有 Agent 任务。</div> : null}
          {tasks.map((task) => (
            <button
              key={task.taskId}
              className={task.taskId === currentTask?.taskId ? "workspace-list-row workspace-list-row-active" : "workspace-list-row"}
              onClick={() => setSelectedTaskId(task.taskId)}
            >
              <strong>{task.taskText}</strong>
              <span>{task.status}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="workspace-editor">
        {currentTask ? (
          <>
            <div className="editor-header">
              <div>
                <div className="workspace-kicker">AGENT</div>
                <h2>{currentTask.taskText}</h2>
              </div>
              <div className="inline-button-row">
                <button
                  className="small-button"
                  disabled={previewMutation.isPending}
                  onClick={() => previewMutation.mutate(currentTask.taskId)}
                >
                  生成预览
                </button>
                <button
                  className="small-button"
                  disabled={
                    confirmMutation.isPending
                    || !["awaiting_approval", "planned"].includes(currentTask.status)
                  }
                  onClick={() => confirmMutation.mutate(currentTask.taskId)}
                >
                  确认执行
                </button>
                <button
                  className="small-button"
                  disabled={rollbackMutation.isPending || currentTask.status !== "completed"}
                  onClick={() => rollbackMutation.mutate(currentTask.taskId)}
                >
                  回滚
                </button>
              </div>
            </div>

            <div className="workspace-panel-title">计划</div>
            <div className="workspace-list workspace-list-static">
              {currentPlan?.steps?.length ? (
                currentPlan.steps.map((step: { stepId: string; title: string; toolName: string; riskLevel: string; reason: string; argumentsJson: string }) => (
                  <div key={step.stepId} className="workspace-list-row workspace-list-row-static">
                    <strong>{step.title}</strong>
                    <span>{step.toolName} / {step.riskLevel}</span>
                    <span>{step.reason}</span>
                    <code>{step.argumentsJson}</code>
                  </div>
                ))
              ) : (
                <div className="empty-hint">当前任务还没有计划。</div>
              )}
            </div>

            <div className="workspace-panel-title">预览</div>
            <div className="workspace-list workspace-list-static">
              {currentPreview?.items?.length ? (
                currentPreview.items.map((item: { itemId: string; label: string; riskLevel: string; beforeSummary?: string; afterSummary?: string }) => (
                  <div key={item.itemId} className="workspace-list-row workspace-list-row-static">
                    <strong>{item.label}</strong>
                    <span>{item.riskLevel}</span>
                    {item.beforeSummary ? <span>前：{item.beforeSummary}</span> : null}
                    {item.afterSummary ? <span>后：{item.afterSummary}</span> : null}
                  </div>
                ))
              ) : (
                <div className="empty-hint">先为当前计划生成 dry-run 预览。</div>
              )}
            </div>
          </>
        ) : (
          <div className="workspace-generic-empty">先创建一个 Agent 任务。</div>
        )}
      </section>

      <aside className="workspace-preview">
        <div className="workspace-panel-title">执行日志</div>
        <div className="workspace-list">
          {(currentAudit?.logs ?? []).map((log) => (
            <div key={log.logId} className="workspace-list-row workspace-list-row-static">
              <strong>{log.level}</strong>
              <span>{log.message}</span>
              <span>{new Date(log.createdAt).toLocaleString()}</span>
            </div>
          ))}
          {!currentAudit?.logs?.length ? <div className="empty-hint">当前没有执行日志。</div> : null}
        </div>

        <div className="workspace-panel-title">审计与差异</div>
        <div className="workspace-list">
          {(currentAudit?.diffs ?? []).map((diff) => (
            <div key={diff.snapshotId} className="workspace-list-row workspace-list-row-static">
              <strong>{diff.label}</strong>
              {diff.beforeText ? <span>前：{diff.beforeText}</span> : null}
              {diff.afterText ? <span>后：{diff.afterText}</span> : null}
            </div>
          ))}
          {!currentAudit?.diffs?.length ? <div className="empty-hint">当前没有可展示的差异。</div> : null}
        </div>
      </aside>
    </section>
  );
}

function safeParse(input: string) {
  try {
    return JSON.parse(input) as {
      steps?: Array<{ stepId: string; title: string; toolName: string; riskLevel: string; reason: string; argumentsJson: string }>;
      items?: Array<{ itemId: string; label: string; riskLevel: string; beforeSummary?: string; afterSummary?: string }>;
    };
  } catch {
    return null;
  }
}
