import type {
  CreateProjectInput,
  CreateProjectOutput,
  DeleteProjectInput,
  DeleteProjectOutput,
  EnqueueJobInput,
  EnqueueJobOutput,
  ImportFilesInput,
  ImportFilesOutput,
  JobCommandOutput,
  ListDocumentsOutput,
  ListJobsOutput,
  ListProjectsOutput,
  OpenProjectInput,
  OpenProjectOutput,
  RunJobInput
} from "@knowledgeos/shared-types";
import { invokeTyped } from "./invoke";
import { desktopCommandSchemas, type BootstrapPayload } from "./schemas";

export async function getBootstrapPayload(): Promise<BootstrapPayload> {
  return invokeTyped(desktopCommandSchemas.appGetBootstrap, undefined);
}

export async function createProject(input: CreateProjectInput): Promise<CreateProjectOutput> {
  return invokeTyped(desktopCommandSchemas.projectCreate, input);
}

export async function openProject(input: OpenProjectInput): Promise<OpenProjectOutput> {
  return invokeTyped(desktopCommandSchemas.projectOpen, input);
}

export async function deleteProject(input: DeleteProjectInput): Promise<DeleteProjectOutput> {
  return invokeTyped(desktopCommandSchemas.projectDelete, input);
}

export async function listProjects(): Promise<ListProjectsOutput> {
  return invokeTyped(desktopCommandSchemas.projectList, undefined);
}

export async function importFiles(input: ImportFilesInput): Promise<ImportFilesOutput> {
  return invokeTyped(desktopCommandSchemas.documentImportFiles, input);
}

export async function listDocuments(projectId: string): Promise<ListDocumentsOutput> {
  return invokeTyped(desktopCommandSchemas.documentList, { projectId });
}

export async function enqueueMockJob(input: EnqueueJobInput): Promise<EnqueueJobOutput> {
  return invokeTyped(desktopCommandSchemas.jobEnqueueMock, input);
}

export async function listJobs(): Promise<ListJobsOutput> {
  return invokeTyped(desktopCommandSchemas.jobList, undefined);
}

export async function runJob(input: RunJobInput): Promise<JobCommandOutput> {
  return invokeTyped(desktopCommandSchemas.jobRun, input);
}

export async function retryJob(input: RunJobInput): Promise<JobCommandOutput> {
  return invokeTyped(desktopCommandSchemas.jobRetry, input);
}

export async function cancelJob(input: RunJobInput): Promise<JobCommandOutput> {
  return invokeTyped(desktopCommandSchemas.jobCancel, input);
}
