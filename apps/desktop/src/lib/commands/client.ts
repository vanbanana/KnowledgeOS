import type {
  BlockCommandOutput,
  CardCommandOutput,
  ExplainBlockInput,
  ExplainBlockOutput,
  GetSourcePreviewInput,
  GetSourcePreviewOutput,
  GetSubgraphInput,
  GetSubgraphOutput,
  ListBlocksOutput,
  ListBlockExplanationsOutput,
  ListCardsOutput,
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
  ListExplainTemplatesOutput,
  ListJobsOutput,
  ListProjectsOutput,
  OpenProjectInput,
  OpenProjectOutput,
  ReaderStateCommandOutput,
  RemoveRelationOutput,
  RelationCommandOutput,
  RelationIdInput,
  RunJobInput,
  SaveCardInput,
  SearchInput,
  SearchOutput,
  SuggestRelationsInput,
  SuggestRelationsOutput,
  UpdateCardInput,
  UpsertRelationInput
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

export async function listBlocks(documentId: string): Promise<ListBlocksOutput> {
  return invokeTyped(desktopCommandSchemas.blockList, { documentId });
}

export async function updateBlock(input: {
  blockId: string;
  isFavorite: boolean;
  note?: string;
}): Promise<BlockCommandOutput> {
  return invokeTyped(desktopCommandSchemas.blockUpdate, input);
}

export async function explainBlock(input: ExplainBlockInput): Promise<ExplainBlockOutput> {
  return invokeTyped(desktopCommandSchemas.blockExplain, input);
}

export async function regenerateBlockExplanation(input: ExplainBlockInput): Promise<ExplainBlockOutput> {
  return invokeTyped(desktopCommandSchemas.blockExplainRegenerate, input);
}

export async function listBlockExplanations(blockId: string): Promise<ListBlockExplanationsOutput> {
  return invokeTyped(desktopCommandSchemas.blockExplainList, { blockId });
}

export async function listExplainTemplates(): Promise<ListExplainTemplatesOutput> {
  return invokeTyped(desktopCommandSchemas.explainTemplateList, undefined);
}

export async function saveCard(input: SaveCardInput): Promise<CardCommandOutput> {
  return invokeTyped(desktopCommandSchemas.cardSave, input);
}

export async function listCards(projectId: string): Promise<ListCardsOutput> {
  return invokeTyped(desktopCommandSchemas.cardList, { projectId });
}

export async function updateCard(input: UpdateCardInput): Promise<CardCommandOutput> {
  return invokeTyped(desktopCommandSchemas.cardUpdate, input);
}

export async function searchProject(input: SearchInput): Promise<SearchOutput> {
  return invokeTyped(desktopCommandSchemas.searchQuery, input);
}

export async function hybridSearchProject(input: SearchInput): Promise<SearchOutput> {
  return invokeTyped(desktopCommandSchemas.searchHybrid, input);
}

export async function getSubgraph(input: GetSubgraphInput): Promise<GetSubgraphOutput> {
  return invokeTyped(desktopCommandSchemas.graphSubgraph, input);
}

export async function suggestRelations(input: SuggestRelationsInput): Promise<SuggestRelationsOutput> {
  return invokeTyped(desktopCommandSchemas.graphSuggestRelations, input);
}

export async function upsertRelation(input: UpsertRelationInput): Promise<RelationCommandOutput> {
  return invokeTyped(desktopCommandSchemas.graphUpsertRelation, input);
}

export async function confirmRelation(input: RelationIdInput): Promise<RelationCommandOutput> {
  return invokeTyped(desktopCommandSchemas.graphConfirmRelation, input);
}

export async function removeRelation(input: RelationIdInput): Promise<RemoveRelationOutput> {
  return invokeTyped(desktopCommandSchemas.graphRemoveRelation, input);
}

export async function upsertReaderState(input: {
  projectId: string;
  documentId: string;
  blockId: string;
  sourceAnchor?: string;
}): Promise<ReaderStateCommandOutput> {
  return invokeTyped(desktopCommandSchemas.readerStateUpsert, input);
}

export async function getSourcePreview(input: GetSourcePreviewInput): Promise<GetSourcePreviewOutput> {
  return invokeTyped(desktopCommandSchemas.readerSourcePreview, input);
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
