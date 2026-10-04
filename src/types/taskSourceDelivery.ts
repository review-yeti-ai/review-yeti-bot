/** Content-free source delivery evidence shared by domain and boundary layers. */
export interface TaskSourceFileReceipt {
  path: string;
  patchDigest: string | null;
  totalChars: number | null;
  ranges: Array<[number, number]>;
  inline: boolean;
}

export interface TaskSourceReceipt {
  version: 'TaskSourceDelivery.v1';
  taskId: string;
  headSha: string;
  baseSha: string | null;
  contextDigests: string[];
  files: TaskSourceFileReceipt[];
  complete: boolean;
}
