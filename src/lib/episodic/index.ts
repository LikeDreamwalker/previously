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
  emptyPreviouslyTemplate,
  CURRENT_PREVIOUSLY_PATH,
  readCurrentPreviously,
  writeCurrentPreviously,
} from "./manager";
// NOTE: sliceIdToLegacyFilePath was removed in v0.5 — old flat-file format
//       support dropped. Use sliceIdToTimelineDir / sliceIdToFilePath instead.
//
// NOTE: maintenance.ts v1 types (SliceMetadata, applyMetadataUpdates) were
//       removed in v0.5.1. Card maintenance / updater passes were removed in
//       v0.8 — card writes are mutation-tool based (card-session.ts), owned
//       by the Previously Agent end to end.

export {
  runRecallSearch,
} from "./flash/recall";
export type {
  RecallHit,
  RecallSearchOutput,
  RecallSearchInput,
} from "./flash/recall";

export {
  analyzeTurn,
  shouldRunCardEvolution,
} from "./flash/turn-analyzer";
export type {
  TurnAnalysis,
  SemanticHint,
  ClosedMarking,
  AnalyzeTurnInput,
} from "./flash/turn-analyzer";

export {
  generateGlobalTimeline,
  updateGlobalTimeline,
} from "./flash/global-timeline";

export {
  consolidateStrands,
} from "./flash/strand-consolidator";
export type {
  ConsolidationResult,
} from "./flash/strand-consolidator";
// ─── v0.8 timeline (first-class derived index) ─────────────────────────
export {
  weaveTimeline,
  readTimelineMd,
  WEAVE_FRESH_MS,
} from "./timeline/weave";
export {
  renderTimelineMd,
  buildTimelineBrief,
  groupByEraAndDay,
  sliceLine,
} from "./timeline/render";
export {
  readTimelineIndex,
  sliceEntryFromDisk,
  upsertTimelineEntry,
  TIMELINE_INDEX_PATH,
  TIMELINE_MD_PATH,
} from "./timeline/store";
export type {
  TimelineIndex,
  TimelineSliceEntry,
  TimelineWeaveResult,
} from "./timeline/types";

export {
  createBatch,
  flushBatch,
} from "./io-helpers";
export type { WriteBatch } from "./io-helpers";

export {
  DEFAULT_MAX_SLICE_AGE_MS,
  DEFAULT_MAX_TURNS_PER_SLICE,
  checkSliceAge,
} from "./slicer";

export {
  normalizeStrandKey,
  findMatchingStrand,
  weaveTag,
  applyStrandMerges,
  pruneStrands,
  slicePathToMs,
} from "./strands";
export {
  deterministicSliceMark,
} from "./slice-mark";
export type {
  SliceMark,
} from "./slice-mark";
export type {
  PruneOptions,
} from "./strands";

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
