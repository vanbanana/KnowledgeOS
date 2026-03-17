import type { Block, Document, Job, Project, ReaderState } from "@knowledgeos/shared-types";
import { create } from "zustand";

export interface BootstrapState {
  appName: string;
  dataDir: string;
  logDir: string;
  projects: Project[];
  documents: Document[];
  readerStates: ReaderState[];
  blocks: Block[];
  jobs: Job[];
}

interface AppStore {
  bootstrap: BootstrapState | null;
  setBootstrap: (bootstrap: BootstrapState) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  bootstrap: null,
  setBootstrap: (bootstrap) => set({ bootstrap })
}));
