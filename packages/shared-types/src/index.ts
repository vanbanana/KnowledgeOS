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
export const documentSourceTypeSchema = z.enum(["pdf", "pptx", "docx", "md", "txt"]);

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

export const createProjectInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().trim().nullish().transform((value) => value ?? null)
});

export const createProjectOutputSchema = z.object({
  project: projectSchema,
  initializedDirectories: z.array(z.string())
});

export const listProjectsOutputSchema = z.object({
  projects: z.array(projectSchema)
});

export const listDocumentsOutputSchema = z.object({
  documents: z.array(documentSchema)
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
    warnings: z.array(z.string())
  })
});

export const commandNameSchema = z.enum([
  "app.getBootstrap",
  "project.create",
  "project.list",
  "document.importFiles",
  "document.list",
  "job.enqueueMock",
  "job.list"
]);

export type AppConfig = z.infer<typeof appConfigSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Document = z.infer<typeof documentSchema>;
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type CreateProjectOutput = z.infer<typeof createProjectOutputSchema>;
export type ListProjectsOutput = z.infer<typeof listProjectsOutputSchema>;
export type ListDocumentsOutput = z.infer<typeof listDocumentsOutputSchema>;
export type ImportFilesInput = z.infer<typeof importFilesInputSchema>;
export type ImportFilesOutput = z.infer<typeof importFilesOutputSchema>;
export type Job = z.infer<typeof jobSchema>;
export type EnqueueJobInput = z.infer<typeof enqueueJobInputSchema>;
export type EnqueueJobOutput = z.infer<typeof enqueueJobOutputSchema>;
export type ListJobsOutput = z.infer<typeof listJobsOutputSchema>;
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
  "job.enqueueMock": {
    input: enqueueJobInputSchema,
    output: enqueueJobOutputSchema
  },
  "job.list": {
    input: z.undefined(),
    output: listJobsOutputSchema
  }
} as const;
