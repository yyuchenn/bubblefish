import type { Envelope, Reply, ProjectDocument } from '../../generated/core';

export type ProjectFormat = 'bf' | 'labelplus';
export interface ImportResult {
  document: ProjectDocument;
  warnings: string[];
  forceSaveAs: boolean;
}
export interface ImageProbe {
  width: number;
  height: number;
  checksum: string;
  format: string;
}
export interface CoreTransport {
  ready(): Promise<void>;
  dispatch(envelope: Envelope): Promise<Reply>;
  importProject(bytes: Uint8Array, format: ProjectFormat, projectId: string): Promise<ImportResult>;
  exportProject(projectId: string, format: ProjectFormat): Promise<Uint8Array>;
  probeImage(bytes: Uint8Array): Promise<ImageProbe>;
  dispose(): void;
}
