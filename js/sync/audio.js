// Native audio SDK snapshot; the manifest pins the exact source bytes.
// Audio shares the immutable 0.3.3 snapshot with the H.264 output path so a
// daemon `audio_unavailable` decodes as SyncUnavailableError (sync 933b158
// classifies contention, hotplug and read failure as recoverable unavailability).
export { SyncBridgeClient } from './sdk/0.3.3/browser/index.js'
