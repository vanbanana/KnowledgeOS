import { z } from "zod";
import {
  appConfigSchema,
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
  runJobInputSchema,
  listProjectsOutputSchema
} from "@knowledgeos/shared-types";

export const bootstrapPayloadSchema = z.object({
  appName: appConfigSchema.shape.appName,
  dataDir: appConfigSchema.shape.dataDir,
  logDir: appConfigSchema.shape.logDir,
  projects: listProjectsOutputSchema.shape.projects,
  documents: listDocumentsOutputSchema.shape.documents,
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
