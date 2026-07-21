export interface PartProgress { partNumber: number; loaded: number; size: number; completed: boolean }
export function aggregateProgress(parts: PartProgress[], fileSize: number) {
  const uploaded = Math.min(fileSize, parts.reduce((sum, part) => sum + Math.min(part.loaded, part.size), 0));
  return { uploaded, ratio: fileSize > 0 ? uploaded / fileSize : 0 };
}
