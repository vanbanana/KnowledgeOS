import { create } from "zustand";

export interface BootstrapState {
  appName: string;
  dataDir: string;
  logDir: string;
  projects: Array<{
    projectId: string;
    name: string;
    description: string | null;
    rootPath: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  }>;
  documents: Array<{
    documentId: string;
    projectId: string;
    sourcePath: string;
    sourceType: "pdf" | "pptx" | "docx" | "md" | "txt";
    sourceHash: string | null;
    normalizedMdPath: string | null;
    manifestPath: string | null;
    title: string | null;
    parseStatus: "imported" | "parsing" | "normalized" | "chunked" | "indexed" | "ready" | "failed";
    importedAt: string;
    updatedAt: string | null;
    lastErrorMessage: string | null;
  }>;
  jobs: Array<{
    jobId: string;
    kind: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    createdAt: string;
    updatedAt: string;
    payloadJson: string;
    errorMessage: string | null;
  }>;
}

interface AppStore {
  bootstrap: BootstrapState | null;
  setBootstrap: (bootstrap: BootstrapState) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  bootstrap: null,
  setBootstrap: (bootstrap) => set({ bootstrap })
}));
