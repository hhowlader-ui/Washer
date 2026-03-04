
export enum FileStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR'
}

export type ProcessingMode = 'RENAME_AND_ANALYZE' | 'ANALYZE_ONLY';

export interface ReferenceNumber {
  type: string;
  value: string;
  context?: string;
}

export interface ManagedPoint {
  text: string;
  status: 'pending' | 'approved' | 'rejected';
  isAsset?: boolean;
  isCreditor?: boolean;
  isHighRisk?: boolean;
}

export interface RenamedFile {
  id: string;
  // Allow null for originalFile when restored from session data
  originalFile: File | null;
  originalName: string;
  newName: string;
  status: FileStatus;
  mode: ProcessingMode;
  summary?: string;
  managedPoints?: ManagedPoint[];
  referenceNumbers?: ReferenceNumber[];
  error?: string;
  category?: string; 
  startTime?: number; // Timestamp when processing started
  selected?: boolean; // New: for UI selection
  bundleId?: string; // New: to group related files
  uniqueCode?: string; // New: Random 6-digit alphanumeric code [{AAAA00}]
}
