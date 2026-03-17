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

