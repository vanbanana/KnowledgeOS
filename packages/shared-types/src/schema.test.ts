import test from "node:test";
import assert from "node:assert/strict";
import {
  createProjectInputSchema,
  deleteProjectInputSchema,
  importFilesInputSchema,
  openProjectInputSchema,
  enqueueJobInputSchema,
  parserParseResponseSchema
} from "./index";

test("createProjectInputSchema 应接受最小输入", () => {
  const parsed = createProjectInputSchema.parse({ name: "测试项目" });
  assert.equal(parsed.name, "测试项目");
  assert.equal(parsed.description, null);
});

test("enqueueJobInputSchema 应填充默认重试次数", () => {
  const parsed = enqueueJobInputSchema.parse({ kind: "mock.job" });
  assert.equal(parsed.maxAttempts, 3);
});

test("importFilesInputSchema 应接受导入参数", () => {
  const parsed = importFilesInputSchema.parse({
    projectId: "project-1",
    paths: ["E:/NOTE/fixtures/documents/sample-note.md"]
  });
  assert.equal(parsed.paths.length, 1);
});

test("项目命令 schema 应接受 projectId", () => {
  assert.equal(openProjectInputSchema.parse({ projectId: "project-1" }).projectId, "project-1");
  assert.equal(deleteProjectInputSchema.parse({ projectId: "project-1" }).deleteFiles, true);
});

test("parserParseResponseSchema 应校验最小解析结果", () => {
  const parsed = parserParseResponseSchema.parse({
    ok: true,
    markdown: "# 标题",
    manifest: {
      title: "标题",
      sourceType: "md",
      sourcePath: "E:/NOTE/sample.md",
      sections: [],
      assets: [],
      warnings: []
    }
  });
  assert.equal(parsed.ok, true);
});
