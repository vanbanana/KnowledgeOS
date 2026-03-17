import { z } from "zod";

export const jobStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled"
]);

export const projectStatusSchema = z.enum(["active", "archived"]);
export const documentStatusSchema = z.enum([
  "imported",
  "parsing",
  "normalized",
  "chunked",
  "indexed",
  "ready",
  "failed"
]);
export const documentSourceTypeSchema = z.enum(["pdf", "pptx", "docx", "md", "txt", "unknown"]);
export const parserJobStatusSchema = z.enum(["pending", "running", "succeeded", "failed", "cancelled"]);
export const blockTypeSchema = z.enum(["section", "paragraph"]);

export const logLevelSchema = z.enum(["trace", "debug", "info", "warn", "error"]);

export const appConfigSchema = z.object({
  appName: z.string(),
  dataDir: z.string(),
  logDir: z.string(),
  defaultLogLevel: logLevelSchema
});

export const projectSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  rootPath: z.string(),
  status: projectStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string()
});

export const documentSchema = z.object({
  documentId: z.string(),
  projectId: z.string(),
  sourcePath: z.string(),
  sourceType: documentSourceTypeSchema,
  sourceHash: z.string().nullable(),
  normalizedMdPath: z.string().nullable(),
  manifestPath: z.string().nullable(),
  title: z.string().nullable(),
  parseStatus: documentStatusSchema,
  importedAt: z.string(),
  updatedAt: z.string().nullable(),
  lastErrorMessage: z.string().nullable()
});

export const blockSchema = z.object({
  blockId: z.string(),
  projectId: z.string(),
  documentId: z.string(),
  blockType: blockTypeSchema,
  title: z.string().nullable(),
  headingPath: z.array(z.string()),
  depth: z.number().int().nonnegative(),
  orderIndex: z.number().int().nonnegative(),
  contentMd: z.string(),
  tokenCount: z.number().int().nonnegative(),
  sourceAnchor: z.string().nullable(),
  parentBlockId: z.string().nullable(),
  isFavorite: z.boolean(),
  note: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const readerStateSchema = z.object({
  projectId: z.string(),
  documentId: z.string(),
  blockId: z.string(),
  sourceAnchor: z.string().nullable(),
  updatedAt: z.string()
});

export const sourcePreviewSchema = z.object({
  anchor: z.string(),
  title: z.string().nullable(),
  excerptMd: z.string()
});

export const createProjectInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().trim().nullish().transform((value) => value ?? null)
});

export const createProjectOutputSchema = z.object({
  project: projectSchema,
  initializedDirectories: z.array(z.string())
});

export const openProjectInputSchema = z.object({
  projectId: z.string().min(1)
});

export const openProjectOutputSchema = z.object({
  project: projectSchema
});

export const deleteProjectInputSchema = z.object({
  projectId: z.string().min(1),
  deleteFiles: z.boolean().default(true)
});

export const deleteProjectOutputSchema = z.object({
  projectId: z.string(),
  deletedFiles: z.boolean()
});

export const listProjectsOutputSchema = z.object({
  projects: z.array(projectSchema)
});

export const listDocumentsOutputSchema = z.object({
  documents: z.array(documentSchema)
});

export const listBlocksOutputSchema = z.object({
  blocks: z.array(blockSchema)
});

export const importFilesInputSchema = z.object({
  projectId: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1)
});

export const importFilesOutputSchema = z.object({
  documents: z.array(documentSchema),
  queuedJobIds: z.array(z.string()),
  errors: z.array(
    z.object({
      path: z.string(),
      message: z.string()
    })
  )
});

export const jobSchema = z.object({
  jobId: z.string(),
  kind: z.string(),
  payloadJson: z.string(),
  status: jobStatusSchema,
  errorMessage: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const enqueueJobInputSchema = z.object({
  kind: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  maxAttempts: z.number().int().positive().default(3)
});

export const enqueueJobOutputSchema = z.object({
  job: jobSchema
});

export const listJobsOutputSchema = z.object({
  jobs: z.array(jobSchema)
});

export const runJobInputSchema = z.object({
  jobId: z.string().min(1)
});

export const jobCommandOutputSchema = z.object({
  job: jobSchema
});

export const blockCommandOutputSchema = z.object({
  block: blockSchema
});

export const upsertReaderStateInputSchema = z.object({
  projectId: z.string().min(1),
  documentId: z.string().min(1),
  blockId: z.string().min(1),
  sourceAnchor: z.string().optional()
});

export const readerStateCommandOutputSchema = z.object({
  readerState: readerStateSchema
});

export const getSourcePreviewInputSchema = z.object({
  documentId: z.string().min(1),
  anchor: z.string().min(1)
});

export const getSourcePreviewOutputSchema = z.object({
  preview: sourcePreviewSchema
});

export const parserHealthResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string()
});

export const parserParseRequestSchema = z.object({
  filePath: z.string(),
  sourceType: z.enum(["md", "txt", "pdf", "pptx", "docx"]).default("md")
});

export const parserParseResponseSchema = z.object({
  ok: z.boolean(),
  markdown: z.string(),
  manifest: z.object({
    title: z.string(),
    sourceType: z.string(),
    sourcePath: z.string().optional(),
    sections: z.array(
      z.object({
        heading: z.string().nullable(),
        anchor: z.string(),
        index: z.number().int().nonnegative()
      })
    ).default([]),
    assets: z.array(z.string()).default([]),
    warnings: z.array(z.string())
  })
});

export const commandNameSchema = z.enum([
  "app.getBootstrap",
  "project.create",
  "project.open",
  "project.delete",
  "project.list",
  "document.importFiles",
  "document.list",
  "block.list",
  "block.update",
  "reader.state.upsert",
  "reader.sourcePreview",
  "job.enqueueMock",
  "job.list",
  "job.run",
  "job.retry",
  "job.cancel"
]);

export type AppConfig = z.infer<typeof appConfigSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Document = z.infer<typeof documentSchema>;
export type Block = z.infer<typeof blockSchema>;
export type ReaderState = z.infer<typeof readerStateSchema>;
export type SourcePreview = z.infer<typeof sourcePreviewSchema>;
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type CreateProjectOutput = z.infer<typeof createProjectOutputSchema>;
export type OpenProjectInput = z.infer<typeof openProjectInputSchema>;
export type OpenProjectOutput = z.infer<typeof openProjectOutputSchema>;
export type DeleteProjectInput = z.infer<typeof deleteProjectInputSchema>;
export type DeleteProjectOutput = z.infer<typeof deleteProjectOutputSchema>;
export type ListProjectsOutput = z.infer<typeof listProjectsOutputSchema>;
export type ListDocumentsOutput = z.infer<typeof listDocumentsOutputSchema>;
export type ListBlocksOutput = z.infer<typeof listBlocksOutputSchema>;
export type ImportFilesInput = z.infer<typeof importFilesInputSchema>;
export type ImportFilesOutput = z.infer<typeof importFilesOutputSchema>;
export type Job = z.infer<typeof jobSchema>;
export type EnqueueJobInput = z.infer<typeof enqueueJobInputSchema>;
export type EnqueueJobOutput = z.infer<typeof enqueueJobOutputSchema>;
export type ListJobsOutput = z.infer<typeof listJobsOutputSchema>;
export type RunJobInput = z.infer<typeof runJobInputSchema>;
export type JobCommandOutput = z.infer<typeof jobCommandOutputSchema>;
export type BlockCommandOutput = z.infer<typeof blockCommandOutputSchema>;
export type ReaderStateCommandOutput = z.infer<typeof readerStateCommandOutputSchema>;
export type GetSourcePreviewInput = z.infer<typeof getSourcePreviewInputSchema>;
export type GetSourcePreviewOutput = z.infer<typeof getSourcePreviewOutputSchema>;
export type ParserHealthResponse = z.infer<typeof parserHealthResponseSchema>;
export type ParserParseRequest = z.infer<typeof parserParseRequestSchema>;
export type ParserParseResponse = z.infer<typeof parserParseResponseSchema>;
export type CommandName = z.infer<typeof commandNameSchema>;

export const commandSchemas = {
  "project.create": {
    input: createProjectInputSchema,
    output: createProjectOutputSchema
  },
  "project.list": {
    input: z.undefined(),
    output: listProjectsOutputSchema
  },
  "project.open": {
    input: openProjectInputSchema,
    output: openProjectOutputSchema
  },
  "project.delete": {
    input: deleteProjectInputSchema,
    output: deleteProjectOutputSchema
  },
  "document.importFiles": {
    input: importFilesInputSchema,
    output: importFilesOutputSchema
  },
  "document.list": {
    input: z.object({
      projectId: z.string().min(1)
    }),
    output: listDocumentsOutputSchema
  },
  "block.list": {
    input: z.object({
      documentId: z.string().min(1)
    }),
    output: listBlocksOutputSchema
  },
  "block.update": {
    input: z.object({
      blockId: z.string().min(1),
      isFavorite: z.boolean(),
      note: z.string().optional()
    }),
    output: blockCommandOutputSchema
  },
  "reader.state.upsert": {
    input: upsertReaderStateInputSchema,
    output: readerStateCommandOutputSchema
  },
  "reader.sourcePreview": {
    input: getSourcePreviewInputSchema,
    output: getSourcePreviewOutputSchema
  },
  "job.enqueueMock": {
    input: enqueueJobInputSchema,
    output: enqueueJobOutputSchema
  },
  "job.list": {
    input: z.undefined(),
    output: listJobsOutputSchema
  },
  "job.run": {
    input: runJobInputSchema,
    output: jobCommandOutputSchema
  },
  "job.retry": {
    input: runJobInputSchema,
    output: jobCommandOutputSchema
  },
  "job.cancel": {
    input: runJobInputSchema,
    output: jobCommandOutputSchema
  }
} as const;
