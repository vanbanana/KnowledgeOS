import test from "node:test";
import assert from "node:assert/strict";
import {
  createProjectInputSchema,
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

test("parserParseResponseSchema 应校验最小解析结果", () => {
  const parsed = parserParseResponseSchema.parse({
    ok: true,
    markdown: "# 标题",
    manifest: {
      title: "标题",
      sourceType: "md",
      warnings: []
    }
  });
  assert.equal(parsed.ok, true);
});
