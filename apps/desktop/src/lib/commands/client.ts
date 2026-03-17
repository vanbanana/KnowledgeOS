import type {
  CreateProjectInput,
  CreateProjectOutput,
  EnqueueJobInput,
  EnqueueJobOutput,
  ListJobsOutput,
  ListProjectsOutput
} from "@knowledgeos/shared-types";
import { invokeTyped } from "./invoke";
import { desktopCommandSchemas, type BootstrapPayload } from "./schemas";

export async function getBootstrapPayload(): Promise<BootstrapPayload> {
  return invokeTyped(desktopCommandSchemas.appGetBootstrap, undefined);
}

export async function createProject(input: CreateProjectInput): Promise<CreateProjectOutput> {
  return invokeTyped(desktopCommandSchemas.projectCreate, input);
}

export async function listProjects(): Promise<ListProjectsOutput> {
  return invokeTyped(desktopCommandSchemas.projectList, undefined);
}

export async function enqueueMockJob(input: EnqueueJobInput): Promise<EnqueueJobOutput> {
  return invokeTyped(desktopCommandSchemas.jobEnqueueMock, input);
}

export async function listJobs(): Promise<ListJobsOutput> {
  return invokeTyped(desktopCommandSchemas.jobList, undefined);
}
