export {
  getActiveSlice,
  createSlice,
  closeSlice,
  getSlicePath,
  sliceIdToRelPath,
  sliceIdToFilePath,
  getIndexPath,
  getStrandsPath,
  serializeSlice,
  parseSlice,
  serializeIndex,
  serializeStrands,
  appendTurn,
  readSliceIndex,
  readStrands,
  readSliceBody,
  toIndexEntry,
  updateMonthlyIndex,
  updateStrands,
  setActiveSlice,
  clearActiveSlice,
  tryLoadTodaySlice,
  saveSliceSnapshot,
  ensureIndexEntries,
  sliceIdToTimelineDir,
  sliceIdToAgentPath,
  writeAgentTimeline,
  readAgentTimeline,
  sliceIdToPreviouslyPath,
  readPreviously,
  writePreviously,
  findMostRecentPreviously,
  ensurePreviously,
  applyPreviouslyDecay,
  emptyPreviouslyTemplate,
} from "./manager";
// NOTE: sliceIdToLegacyFilePath was removed in v0.5 — old flat-file format
//       support dropped. Use sliceIdToTimelineDir / sliceIdToFilePath instead.
//
// NOTE: maintenance.ts v1 types (SliceMetadata, applyMetadataUpdates) were
//       removed in v0.5.1. Use previously-updater.ts (v2) instead.

export {
  runRecallSearch,
} from "./flash/recall";
export type {
  RecallHit,
  RecallSearchOutput,
  RecallSearchInput,
} from "./flash/recall";

export {
  generateGlobalTimeline,
  updateGlobalTimeline,
  formatEntry,
  buildTimelineContent,
} from "./flash/global-timeline";
export type {
  TimelineEntry,
} from "./flash/global-timeline";

export {
  DEFAULT_TIME_SILENCE_MS,
  DEFAULT_MAX_TURNS_PER_SLICE,
  checkTimeSilence,
} from "./slicer";

export type {
  SliceStatus,
  SlicingSignal,
  EmotionalTone,
  Turn,
  SliceFrontmatter,
  TimeSlice,
  SliceIndexEntry,
  MonthlyIndex,
  StrandIndex,
} from "./types";
