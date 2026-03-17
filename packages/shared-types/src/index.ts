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

export const modelTaskTypeSchema = z.enum([
  "block.explain",
  "graph.suggestRelations",
  "agent.plan",
  "search.rewrite"
]);

export const modelRequestSchema = z.object({
  taskType: modelTaskTypeSchema,
  provider: z.string(),
  model: z.string(),
  prompt: z.string(),
  contextBlocks: z.array(z.string()).default([]),
  metadataJson: z.string().default("{}"),
  temperature: z.number(),
  maxOutputTokens: z.number().int().positive()
});

export const modelResponseSchema = z.object({
  provider: z.string(),
  model: z.string(),
  outputText: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  cacheHit: z.boolean()
});

export const explainKeyConceptSchema = z.object({
  term: z.string(),
  explanation: z.string()
});

export const explainRelatedCandidateSchema = z.object({
  label: z.string(),
  relationHint: z.string(),
  confidence: z.number()
});

export const explainResultSchema = z.object({
  summary: z.string(),
  keyConcepts: z.array(explainKeyConceptSchema).default([]),
  roleInDocument: z.string(),
  prerequisites: z.array(z.string()).default([]),
  pitfalls: z.array(z.string()).default([]),
  examples: z.array(z.string()).default([]),
  relatedCandidates: z.array(explainRelatedCandidateSchema).default([]),
  mode: z.string(),
  promptVersion: z.string()
});

export const explainTemplateSchema = z.object({
  promptVersion: z.string(),
  mode: z.string(),
  systemPrompt: z.string(),
  userPromptTemplate: z.string(),
  outputSchemaJson: z.string()
});

export const blockExplanationSchema = z.object({
  explanationId: z.string(),
  blockId: z.string(),
  mode: z.string(),
  summary: z.string(),
  keyConceptsJson: z.string(),
  prerequisitesJson: z.string(),
  pitfallsJson: z.string(),
  roleInDocument: z.string(),
  relatedCandidatesJson: z.string(),
  examplesJson: z.string(),
  modelName: z.string(),
  promptVersion: z.string(),
  cacheKey: z.string(),
  rawResponseJson: z.string(),
  createdAt: z.string()
});

export const cardSchema = z.object({
  cardId: z.string(),
  projectId: z.string(),
  sourceBlockId: z.string().nullable(),
  sourceExplanationId: z.string().nullable(),
  title: z.string(),
  contentMd: z.string(),
  tagsJson: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const saveCardInputSchema = z.object({
  projectId: z.string().optional(),
  sourceBlockId: z.string().optional(),
  sourceExplanationId: z.string().optional(),
  title: z.string().optional(),
  contentMd: z.string().optional(),
  tags: z.array(z.string()).default([])
});

export const updateCardInputSchema = z.object({
  cardId: z.string().min(1),
  title: z.string().min(1),
  contentMd: z.string().min(1),
  tags: z.array(z.string()).default([])
});

export const listCardsOutputSchema = z.object({
  cards: z.array(cardSchema)
});

export const cardCommandOutputSchema = z.object({
  card: cardSchema
});

export const searchResultSchema = z.object({
  entityType: z.string(),
  entityId: z.string(),
  projectId: z.string(),
  title: z.string(),
  snippet: z.string(),
  source: z.string(),
  jumpTarget: z.string(),
  score: z.number()
});

export const searchInputSchema = z.object({
  projectId: z.string().min(1),
  query: z.string().min(1)
});

export const searchOutputSchema = z.object({
  results: z.array(searchResultSchema)
});

export const graphNodeSchema = z.object({
  nodeId: z.string(),
  projectId: z.string(),
  nodeType: z.string(),
  label: z.string(),
  sourceRef: z.string().nullable(),
  metadataJson: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const graphRelationSchema = z.object({
  relationId: z.string(),
  projectId: z.string(),
  fromNodeId: z.string(),
  toNodeId: z.string(),
  relationType: z.string(),
  confidence: z.number().nullable(),
  originType: z.string(),
  sourceRef: z.string().nullable(),
  confirmedByUser: z.boolean(),
  createdAt: z.string()
});

export const relationSuggestionSchema = z.object({
  relation: graphRelationSchema,
  fromNodeLabel: z.string(),
  toNodeLabel: z.string()
});

export const getSubgraphInputSchema = z.object({
  projectId: z.string().min(1),
  nodeTypes: z.array(z.string()).default([]),
  queryText: z.string().optional(),
  relationConfirmedOnly: z.boolean().optional()
});

export const getSubgraphOutputSchema = z.object({
  subgraph: z.object({
    nodes: z.array(graphNodeSchema),
    relations: z.array(graphRelationSchema)
  })
});

export const suggestRelationsInputSchema = z.object({
  cardId: z.string().min(1)
});

export const suggestRelationsOutputSchema = z.object({
  suggestions: z.array(relationSuggestionSchema)
});

export const upsertRelationInputSchema = z.object({
  projectId: z.string().min(1),
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  relationType: z.string().min(1),
  confidence: z.number().optional(),
  originType: z.string().optional(),
  sourceRef: z.string().optional(),
  confirmedByUser: z.boolean().optional()
});

export const relationIdInputSchema = z.object({
  relationId: z.string().min(1)
});

export const relationCommandOutputSchema = z.object({
  relation: graphRelationSchema
});

export const removeRelationOutputSchema = z.object({
  removed: z.boolean()
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

export const explainBlockInputSchema = z.object({
  blockId: z.string().min(1),
  mode: z.string().optional()
});

export const regenerateExplainBlockInputSchema = explainBlockInputSchema;

export const explainBlockOutputSchema = z.object({
  explanation: blockExplanationSchema
});

export const listBlockExplanationsOutputSchema = z.object({
  explanations: z.array(blockExplanationSchema)
});

export const listExplainTemplatesOutputSchema = z.object({
  templates: z.array(explainTemplateSchema)
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
  "block.explain",
  "block.explain.regenerate",
  "block.explain.list",
  "explain.templates.list",
  "card.save",
  "card.list",
  "card.update",
  "search.query",
  "search.hybrid",
  "graph.subgraph",
  "graph.suggestRelations",
  "graph.relation.upsert",
  "graph.relation.confirm",
  "graph.relation.remove",
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
export type ModelRequest = z.infer<typeof modelRequestSchema>;
export type ModelResponse = z.infer<typeof modelResponseSchema>;
export type ExplainResult = z.infer<typeof explainResultSchema>;
export type ExplainTemplate = z.infer<typeof explainTemplateSchema>;
export type BlockExplanation = z.infer<typeof blockExplanationSchema>;
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
export type ExplainBlockInput = z.infer<typeof explainBlockInputSchema>;
export type ExplainBlockOutput = z.infer<typeof explainBlockOutputSchema>;
export type RegenerateExplainBlockInput = z.infer<typeof regenerateExplainBlockInputSchema>;
export type ListBlockExplanationsOutput = z.infer<typeof listBlockExplanationsOutputSchema>;
export type ListExplainTemplatesOutput = z.infer<typeof listExplainTemplatesOutputSchema>;
export type Card = z.infer<typeof cardSchema>;
export type SaveCardInput = z.infer<typeof saveCardInputSchema>;
export type UpdateCardInput = z.infer<typeof updateCardInputSchema>;
export type ListCardsOutput = z.infer<typeof listCardsOutputSchema>;
export type CardCommandOutput = z.infer<typeof cardCommandOutputSchema>;
export type SearchInput = z.infer<typeof searchInputSchema>;
export type SearchOutput = z.infer<typeof searchOutputSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphRelation = z.infer<typeof graphRelationSchema>;
export type RelationSuggestion = z.infer<typeof relationSuggestionSchema>;
export type GetSubgraphInput = z.infer<typeof getSubgraphInputSchema>;
export type GetSubgraphOutput = z.infer<typeof getSubgraphOutputSchema>;
export type SuggestRelationsInput = z.infer<typeof suggestRelationsInputSchema>;
export type SuggestRelationsOutput = z.infer<typeof suggestRelationsOutputSchema>;
export type UpsertRelationInput = z.infer<typeof upsertRelationInputSchema>;
export type RelationIdInput = z.infer<typeof relationIdInputSchema>;
export type RelationCommandOutput = z.infer<typeof relationCommandOutputSchema>;
export type RemoveRelationOutput = z.infer<typeof removeRelationOutputSchema>;
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
  "block.explain": {
    input: explainBlockInputSchema,
    output: explainBlockOutputSchema
  },
  "block.explain.regenerate": {
    input: regenerateExplainBlockInputSchema,
    output: explainBlockOutputSchema
  },
  "block.explain.list": {
    input: z.object({
      blockId: z.string().min(1)
    }),
    output: listBlockExplanationsOutputSchema
  },
  "explain.templates.list": {
    input: z.undefined(),
    output: listExplainTemplatesOutputSchema
  },
  "card.save": {
    input: saveCardInputSchema,
    output: cardCommandOutputSchema
  },
  "card.list": {
    input: z.object({
      projectId: z.string().min(1)
    }),
    output: listCardsOutputSchema
  },
  "card.update": {
    input: updateCardInputSchema,
    output: cardCommandOutputSchema
  },
  "search.query": {
    input: searchInputSchema,
    output: searchOutputSchema
  },
  "search.hybrid": {
    input: searchInputSchema,
    output: searchOutputSchema
  },
  "graph.subgraph": {
    input: getSubgraphInputSchema,
    output: getSubgraphOutputSchema
  },
  "graph.suggestRelations": {
    input: suggestRelationsInputSchema,
    output: suggestRelationsOutputSchema
  },
  "graph.relation.upsert": {
    input: upsertRelationInputSchema,
    output: relationCommandOutputSchema
  },
  "graph.relation.confirm": {
    input: relationIdInputSchema,
    output: relationCommandOutputSchema
  },
  "graph.relation.remove": {
    input: relationIdInputSchema,
    output: removeRelationOutputSchema
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
