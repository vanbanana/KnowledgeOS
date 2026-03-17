import { z } from "zod";
import {
  appConfigSchema,
  createProjectInputSchema,
  createProjectOutputSchema,
  importFilesInputSchema,
  importFilesOutputSchema,
  listDocumentsOutputSchema,
  enqueueJobInputSchema,
  enqueueJobOutputSchema,
  listJobsOutputSchema,
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
  }
} as const;

export type BootstrapPayload = z.infer<typeof bootstrapPayloadSchema>;
