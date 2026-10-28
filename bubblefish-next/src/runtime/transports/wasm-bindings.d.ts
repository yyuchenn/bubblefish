/** The generated package is a build artifact. This stable interface also permits pre-build type checks. */
declare module '*bubblefish_wasm' {
  export default function init(): Promise<unknown>;
  export class CoreHost {
    constructor();
    dispatch(envelope: unknown): unknown;
    document(projectId: string): unknown;
    importProject(bytes: Uint8Array, format: string, projectId: string): unknown;
    exportProject(projectId: string, format: string): Uint8Array;
    probeImage(bytes: Uint8Array): unknown;
    free(): void;
  }
}
