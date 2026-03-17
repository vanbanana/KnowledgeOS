import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { BootstrapState } from "../state";
import { createProject, enqueueMockJob } from "../lib/commands/client";

interface DashboardProps {
  bootstrap: BootstrapState;
}

export function Dashboard({ bootstrap }: DashboardProps) {
  const queryClient = useQueryClient();

  const createProjectMutation = useMutation({
    mutationFn: async () =>
      createProject({
        name: `项目 ${bootstrap.projects.length + 1}`,
        description: "由桌面壳初始化页创建"
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
    }
  });

  const enqueueJobMutation = useMutation({
    mutationFn: async () =>
      enqueueMockJob({
        kind: "mock.bootstrap",
        payload: { source: "dashboard" },
        maxAttempts: 3
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["desktop-bootstrap"] });
    }
  });

  return (
    <main className="app-shell">
      <section className="hero-card">
        <div>
          <p className="eyebrow">KnowledgeOS</p>
          <h1>桌面壳与数据底座</h1>
          <p className="hero-copy">
            当前阶段已切换到 Tauri + React + TypeScript + Rust + SQLite 架构，不使用 Electron。
          </p>
        </div>
        <div className="button-row">
          <button onClick={() => createProjectMutation.mutate()} disabled={createProjectMutation.isPending}>
            创建示例项目
          </button>
          <button
            className="secondary"
            onClick={() => enqueueJobMutation.mutate()}
            disabled={enqueueJobMutation.isPending}
          >
            创建 Mock Job
          </button>
        </div>
      </section>

      <section className="info-grid">
        <article className="panel">
          <h2>应用信息</h2>
          <dl className="key-values">
            <div>
              <dt>应用名</dt>
              <dd>{bootstrap.appName}</dd>
            </div>
            <div>
              <dt>数据目录</dt>
              <dd>{bootstrap.dataDir}</dd>
            </div>
            <div>
              <dt>日志目录</dt>
              <dd>{bootstrap.logDir}</dd>
            </div>
          </dl>
        </article>

        <article className="panel">
          <h2>项目列表</h2>
          <ul className="item-list">
            {bootstrap.projects.length === 0 ? <li>暂无项目</li> : null}
            {bootstrap.projects.map((project) => (
              <li key={project.projectId}>
                <strong>{project.name}</strong>
                <span>{project.rootPath}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h2>任务队列</h2>
          <ul className="item-list">
            {bootstrap.jobs.length === 0 ? <li>暂无任务</li> : null}
            {bootstrap.jobs.map((job) => (
              <li key={job.jobId}>
                <strong>{job.kind}</strong>
                <span>
                  {job.status} / {job.attempts} / {job.maxAttempts}
                </span>
              </li>
            ))}
          </ul>
        </article>
      </section>
    </main>
  );
}
