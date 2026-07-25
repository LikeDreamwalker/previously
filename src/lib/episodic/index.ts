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

export type {
  SliceMetadata,
  BeliefUpdate,
} from "./maintenance";
export {
  applyMetadataUpdates,
  applyBeliefUpdates,
} from "./maintenance";

export {
  runMetadataUpdate,
} from "./flash/metadata";
export type {
  MetadataUpdateInput,
  MetadataUpdateOutput,
} from "./flash/metadata";

export {
  runUpdatePreviously,
} from "./flash/update-previously";
export type {
  UpdatePreviouslyInput,
  UpdatePreviouslyOutput,
} from "./flash/update-previously";

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
