// DROP BINS — main-process entry point.
//
// This file exists so the feature costs main/index.ts exactly ONE line:
//     import './ops/dropbins'
// (the same self-registration pattern as './platform/names'). Each module below
// registers its own ipcMain.handle(CH(...)) at import time, so main/ipc.ts and
// shared/ipc.ts stay untouched and this feature can be removed by deleting that
// one line plus these files.
//
//   state/bins  -> binsGet / binsSet            (config + the Stack, persisted)
//   ops/convert -> convertFormats / convertImages / convertCancel
//   ops/checksums -> checksumsRun / checksumsCancel
import '../state/bins'
import './convert'
import './checksums'
