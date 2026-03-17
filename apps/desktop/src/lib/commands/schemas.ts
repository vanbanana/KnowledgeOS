import { z } from "zod";
import {
  appConfigSchema,
  blockCommandOutputSchema,
  getSourcePreviewInputSchema,
  getSourcePreviewOutputSchema,
  listBlocksOutputSchema,
  createProjectInputSchema,
  createProjectOutputSchema,
  deleteProjectInputSchema,
  deleteProjectOutputSchema,
  importFilesInputSchema,
  importFilesOutputSchema,
  listDocumentsOutputSchema,
  enqueueJobInputSchema,
  enqueueJobOutputSchema,
  jobCommandOutputSchema,
  listJobsOutputSchema,
  openProjectInputSchema,
  openProjectOutputSchema,
  readerStateCommandOutputSchema,
  runJobInputSchema,
  listProjectsOutputSchema,
  upsertReaderStateInputSchema
} from "@knowledgeos/shared-types";

export const bootstrapPayloadSchema = z.object({
  appName: appConfigSchema.shape.appName,
  dataDir: appConfigSchema.shape.dataDir,
  logDir: appConfigSchema.shape.logDir,
  projects: listProjectsOutputSchema.shape.projects,
  documents: listDocumentsOutputSchema.shape.documents,
  readerStates: z.array(readerStateCommandOutputSchema.shape.readerState),
  blocks: listBlocksOutputSchema.shape.blocks,
  jobs: listJobsOutputSchema.shape.jobs
});

export const desktopCommandSchemas = {
  appGetBootstrap: {
    command: "get_bootstrap_payload",
    input: z.undefined(),
    output: bootstrapPayloadSchema
  },
  projectCreate: {
    command: "create_project",
    input: createProjectInputSchema,
    output: createProjectOutputSchema
  },
  projectOpen: {
    command: "open_project",
    input: openProjectInputSchema,
    output: openProjectOutputSchema
  },
  projectDelete: {
    command: "delete_project",
    input: deleteProjectInputSchema,
    output: deleteProjectOutputSchema
  },
  projectList: {
    command: "list_projects",
    input: z.undefined(),
    output: listProjectsOutputSchema
  },
  documentImportFiles: {
    command: "import_files_command",
    input: importFilesInputSchema,
    output: importFilesOutputSchema
  },
  documentList: {
    command: "list_documents_command",
    input: z.object({
      projectId: z.string().min(1)
    }),
    output: listDocumentsOutputSchema
  },
  blockList: {
    command: "list_blocks_command",
    input: z.object({
      documentId: z.string().min(1)
    }),
    output: listBlocksOutputSchema
  },
  blockUpdate: {
    command: "update_block_command",
    input: z.object({
      blockId: z.string().min(1),
      isFavorite: z.boolean(),
      note: z.string().optional()
    }),
    output: blockCommandOutputSchema
  },
  readerStateUpsert: {
    command: "upsert_reader_state_command",
    input: upsertReaderStateInputSchema,
    output: readerStateCommandOutputSchema
  },
  readerSourcePreview: {
    command: "get_source_preview_command",
    input: getSourcePreviewInputSchema,
    output: getSourcePreviewOutputSchema
  },
  jobEnqueueMock: {
    command: "enqueue_mock_job",
    input: enqueueJobInputSchema,
    output: enqueueJobOutputSchema
  },
  jobList: {
    command: "list_jobs",
    input: z.undefined(),
    output: listJobsOutputSchema
  },
  jobRun: {
    command: "run_job_command",
    input: runJobInputSchema,
    output: jobCommandOutputSchema
  },
  jobRetry: {
    command: "retry_job_command",
    input: runJobInputSchema,
    output: jobCommandOutputSchema
  },
  jobCancel: {
    command: "cancel_job_command",
    input: runJobInputSchema,
    output: jobCommandOutputSchema
  }
} as const;

export type BootstrapPayload = z.infer<typeof bootstrapPayloadSchema>;
