import { z } from "zod";
import {
  appConfigSchema,
  blockCommandOutputSchema,
  cardCommandOutputSchema,
  chatWithBlockInputSchema,
  chatWithBlockOutputSchema,
  planAgentTaskInputSchema,
  planAgentTaskOutputSchema,
  listAgentTasksInputSchema,
  listAgentTasksOutputSchema,
  agentTaskIdInputSchema,
  generateAgentPreviewOutputSchema,
  agentTaskCommandOutputSchema,
  rollbackAgentTaskOutputSchema,
  listAgentTaskLogsOutputSchema,
  getAgentAuditOutputSchema,
  getSourcePreviewInputSchema,
  getSourcePreviewOutputSchema,
  graphRagQueryInputSchema,
  graphRagQueryOutputSchema,
  getSubgraphInputSchema,
  getSubgraphOutputSchema,
  listBlocksOutputSchema,
  listBlockExplanationsOutputSchema,
  listDocumentBlockExplanationsInputSchema,
  listDocumentBlockExplanationsOutputSchema,
  listCardsOutputSchema,
  createProjectInputSchema,
  createProjectOutputSchema,
  deleteBlockInputSchema,
  deleteBlockOutputSchema,
  deleteDocumentInputSchema,
  deleteDocumentOutputSchema,
  deleteProjectInputSchema,
  deleteProjectOutputSchema,
  explainBlockInputSchema,
  explainBlockOutputSchema,
  importFilesInputSchema,
  importFilesOutputSchema,
  listDocumentsOutputSchema,
  listExplainTemplatesOutputSchema,
  enqueueJobInputSchema,
  enqueueJobOutputSchema,
  jobCommandOutputSchema,
  listJobsOutputSchema,
  openProjectInputSchema,
  openProjectOutputSchema,
  renameProjectInputSchema,
  renameProjectOutputSchema,
  readerStateCommandOutputSchema,
  relationCommandOutputSchema,
  relationIdInputSchema,
  removeRelationOutputSchema,
  runJobInputSchema,
  saveCardInputSchema,
  searchInputSchema,
  searchOutputSchema,
  createStudioArtifactInputSchema,
  studioArtifactCommandOutputSchema,
  listStudioArtifactsInputSchema,
  listStudioArtifactsOutputSchema,
  generateStudioArtifactInputSchema,
  getStudioArtifactInputSchema,
  suggestRelationsInputSchema,
  suggestRelationsOutputSchema,
  listProjectsOutputSchema,
  updateCardInputSchema,
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
  projectRename: {
    command: "rename_project",
    input: renameProjectInputSchema,
    output: renameProjectOutputSchema
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
  documentDelete: {
    command: "delete_document_command",
    input: deleteDocumentInputSchema,
    output: deleteDocumentOutputSchema
  },
  blockList: {
    command: "list_blocks_command",
    input: z.object({
      documentId: z.string().min(1)
    }),
    output: listBlocksOutputSchema
  },
  blockInsertNote: {
    command: "insert_note_block_command",
    input: z.object({
      documentId: z.string().min(1),
      beforeBlockId: z.string().min(1).optional(),
      title: z.string().optional(),
      contentMd: z.string().min(1)
    }),
    output: blockCommandOutputSchema
  },
  blockUpdate: {
    command: "update_block_command",
    input: z.object({
      blockId: z.string().min(1),
      isFavorite: z.boolean().optional(),
      note: z.string().optional(),
      title: z.string().nullable().optional(),
      contentMd: z.string().min(1).optional()
    }),
    output: blockCommandOutputSchema
  },
  blockDelete: {
    command: "delete_block_command",
    input: deleteBlockInputSchema,
    output: deleteBlockOutputSchema
  },
  blockExplain: {
    command: "explain_block_command",
    input: explainBlockInputSchema,
    output: explainBlockOutputSchema
  },
  blockExplainRegenerate: {
    command: "regenerate_block_explanation_command",
    input: explainBlockInputSchema,
    output: explainBlockOutputSchema
  },
  blockExplainList: {
    command: "list_block_explanations_command",
    input: z.object({
      blockId: z.string().min(1)
    }),
    output: listBlockExplanationsOutputSchema
  },
  blockExplainDocumentList: {
    command: "list_document_block_explanations_command",
    input: listDocumentBlockExplanationsInputSchema,
    output: listDocumentBlockExplanationsOutputSchema
  },
  explainTemplateList: {
    command: "list_explain_templates_command",
    input: z.undefined(),
    output: listExplainTemplatesOutputSchema
  },
  cardSave: {
    command: "save_card_command",
    input: saveCardInputSchema,
    output: cardCommandOutputSchema
  },
  cardList: {
    command: "list_cards_command",
    input: z.object({
      projectId: z.string().min(1)
    }),
    output: listCardsOutputSchema
  },
  cardUpdate: {
    command: "update_card_command",
    input: updateCardInputSchema,
    output: cardCommandOutputSchema
  },
  searchQuery: {
    command: "search_project_command",
    input: searchInputSchema,
    output: searchOutputSchema
  },
  searchHybrid: {
    command: "hybrid_search_project_command",
    input: searchInputSchema,
    output: searchOutputSchema
  },
  graphSubgraph: {
    command: "get_subgraph_command",
    input: getSubgraphInputSchema,
    output: getSubgraphOutputSchema
  },
  graphRagQuery: {
    command: "graph_rag_query_command",
    input: graphRagQueryInputSchema,
    output: graphRagQueryOutputSchema
  },
  graphSuggestRelations: {
    command: "suggest_relations_command",
    input: suggestRelationsInputSchema,
    output: suggestRelationsOutputSchema
  },
  graphUpsertRelation: {
    command: "upsert_relation_command",
    input: z.object({
      projectId: z.string().min(1),
      fromNodeId: z.string().min(1),
      toNodeId: z.string().min(1),
      relationType: z.string().min(1),
      confidence: z.number().optional(),
      originType: z.string().optional(),
      sourceRef: z.string().optional(),
      confirmedByUser: z.boolean().optional()
    }),
    output: relationCommandOutputSchema
  },
  graphConfirmRelation: {
    command: "confirm_relation_command",
    input: relationIdInputSchema,
    output: relationCommandOutputSchema
  },
  graphRemoveRelation: {
    command: "remove_relation_command",
    input: relationIdInputSchema,
    output: removeRelationOutputSchema
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
  readerChatWithBlock: {
    command: "chat_with_block_command",
    input: chatWithBlockInputSchema,
    output: chatWithBlockOutputSchema
  },
  agentPlan: {
    command: "plan_agent_task_command",
    input: planAgentTaskInputSchema,
    output: planAgentTaskOutputSchema
  },
  agentList: {
    command: "list_agent_tasks_command",
    input: listAgentTasksInputSchema,
    output: listAgentTasksOutputSchema
  },
  agentPreview: {
    command: "generate_agent_preview_command",
    input: agentTaskIdInputSchema,
    output: generateAgentPreviewOutputSchema
  },
  agentConfirm: {
    command: "confirm_agent_task_command",
    input: agentTaskIdInputSchema,
    output: agentTaskCommandOutputSchema
  },
  agentRollback: {
    command: "rollback_agent_task_command",
    input: agentTaskIdInputSchema,
    output: rollbackAgentTaskOutputSchema
  },
  agentLogs: {
    command: "list_agent_task_logs_command",
    input: agentTaskIdInputSchema,
    output: listAgentTaskLogsOutputSchema
  },
  agentAudit: {
    command: "get_agent_audit_command",
    input: agentTaskIdInputSchema,
    output: getAgentAuditOutputSchema
  },
  studioCreate: {
    command: "create_studio_artifact_command",
    input: createStudioArtifactInputSchema,
    output: studioArtifactCommandOutputSchema
  },
  studioGenerate: {
    command: "generate_studio_artifact_command",
    input: generateStudioArtifactInputSchema,
    output: studioArtifactCommandOutputSchema
  },
  studioList: {
    command: "list_studio_artifacts_command",
    input: listStudioArtifactsInputSchema,
    output: listStudioArtifactsOutputSchema
  },
  studioGet: {
    command: "get_studio_artifact_command",
    input: getStudioArtifactInputSchema,
    output: studioArtifactCommandOutputSchema
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
