export interface DshAttributionIdentity {
  readonly package: string;
  readonly version: string;
  readonly source: string;
  readonly sourceSha256: string;
}
export function dshAttributionIdentity(root: string): Promise<DshAttributionIdentity>;
export function adaptDshAttribution(
  code: string,
  identity: DshAttributionIdentity,
  includedInSourceMap: boolean,
): {
  readonly code: string;
  readonly adaptation: DshAttributionIdentity & {
    readonly replacements: number;
    readonly reason: string;
    readonly generatedModule?: string;
    readonly sourceMapOffsetsPreserved?: boolean;
  };
};
