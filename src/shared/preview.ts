// Preview pane vocabulary — shared by the renderer (views/preview.ts) and the
// main process (platform/preview.ts + platform/protocols.ts).
//
// Nothing here imports from types.ts/ipc.ts: the preview feature is additive and
// must not widen the core contract.

// ---------------------------------------------------------------------------
// liqfile:// — raw file bytes for <img>/<video>/<audio>/<embed>
// ---------------------------------------------------------------------------
//
// MUST be a *standard* scheme (registerSchemesAsPrivileged standard:true), hence
// the mandatory host segment below. Measured on Electron 38 / Chromium 140:
// with a non-standard scheme Chromium serves the first response fine but
// REJECTS every follow-up range request ("PIPELINE_ERROR_READ: FFmpegDemuxer:
// data source error") the moment the media element defers and resumes — which
// preload="metadata" always triggers. As a standard scheme the identical
// handler seeks correctly (verified: a seek to 0:50 of a 60 s mp4 issued
// `Range: bytes=3244032-` and played from there).

export const LIQFILE_HOST = 'file'

/** liqfile://file/?path=<abs>[&type=<mime>][#frag] */
export function previewURL(absPath: string, opts: { type?: string; fragment?: string } = {}): string {
  const q = new URLSearchParams()
  q.set('path', absPath)
  if (opts.type) q.set('type', opts.type)
  return `liqfile://${LIQFILE_HOST}/?${q.toString()}${opts.fragment ? '#' + opts.fragment : ''}`
}

/** What we ASK Chromium to decode, which is not always the file's real mime:
 *  .mov is usually h264/aac in a QuickTime container Chromium demuxes happily,
 *  but canPlayType('video/quicktime') is ''. An extension missing from this
 *  table falls back to the file's own mime, and an empty canPlayType() is the
 *  signal to stay on the static thumbnail. Shared by the preview pane
 *  (views/preview.ts) and the live tile previews (views/livemedia.ts). */
export const PROBE_MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm',
  ogv: 'video/ogg', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  wav: 'audio/wav', wave: 'audio/wav', mka: 'audio/webm',
}

/**
 * Containers Chromium demuxes but does not list in canPlayType's MIME
 * allowlist. Measured on this Electron: a VP9+Opus MKV and an H.264+Opus MKV
 * both play with readyState 4 and currentTime advancing 2.96s in 2s of wall
 * time, while `canPlayType('video/x-matroska')` returns '' for both.
 * libffmpeg carries ff_matroska_demuxer; only the allowlist lacks the type.
 *
 * AVI, WMV/ASF and FLV are deliberately absent — libffmpeg has no demuxer for
 * any of them, and an H.264+AAC FLV was confirmed to fail under every MIME
 * label that was tried. Those genuinely need ffmpeg.
 */
export const OPTIMISTIC_CONTAINER = new Set(['mkv', 'mka'])

/**
 * canPlayType, corrected for the containers above. Where it under-reports we
 * attempt playback and let the element's own `error` event be the verdict:
 * being wrong that way costs one decode attempt and lands in a fallback that
 * already exists, while being wrong the other way silently refused files that
 * play perfectly — which is what "lots of videos aren't playing" mostly was.
 */
export function likelyPlayable(ext: string, probeMime: string, kind: 'video' | 'audio'): boolean {
  if (document.createElement(kind).canPlayType(probeMime)) return true
  return OPTIMISTIC_CONTAINER.has(ext)
}

// ---------------------------------------------------------------------------
// budgets — every one of these exists because /mnt/share is a hard-mounted CIFS
// ---------------------------------------------------------------------------

export const PREVIEW = {
  /** selection settles for this long before anything is read */
  debounceMs: 150,
  /** hard cap on a text preview read */
  textMaxBytes: 256 * 1024,
  /** a main-side read that takes longer than this reports timedOut instead of hanging the pane */
  readTimeoutMs: 4000,
  /** archive listings shell out to 7z — give up on the UI side after this */
  archiveTimeoutMs: 10_000,
  /** rows rendered from an archive listing before "…and N more" */
  archiveMaxRows: 400,
  /** on a network mount, anything bigger needs an explicit click */
  remoteAutoMaxBytes: 24 * 1024 * 1024,
  /** locally, anything bigger needs an explicit click (Chromium buffers media) */
  localAutoMaxBytes: 512 * 1024 * 1024,
  /** cover art returned from previewTags is capped at this */
  coverMaxBytes: 3 * 1024 * 1024,
} as const

// ---------------------------------------------------------------------------
// IPC payloads (methods: 'previewText', 'previewTags' — self-registered)
// ---------------------------------------------------------------------------

export interface PreviewTextResult {
  ok: boolean
  text: string
  /** bytes actually read */
  bytes: number
  /** file size when it was read */
  size: number
  truncated: boolean
  /** NUL bytes / undecodable — do not render as text */
  binary: boolean
  /** the read exceeded PREVIEW.readTimeoutMs (slow or hung mount) */
  timedOut: boolean
  error?: string
}

export interface PreviewCover {
  mime: string
  /** base64 (CSP allows data: for img-src) */
  data: string
}

export interface PreviewTags {
  title?: string
  artist?: string
  album?: string
  year?: string
  track?: string
  cover?: PreviewCover
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

export type PreviewKind =
  | 'empty'      // nothing selected — folder summary
  | 'multi'      // N items selected
  | 'folder'
  | 'image'      // Chromium can decode it inline
  | 'video'
  | 'audio'
  | 'text'
  | 'pdf'
  | 'archive'
  | 'other'      // big icon + name/type/size (thumbnail if one exists)

/** Extensions Chromium decodes natively. Everything else image-ish -> thumbnail. */
const IMAGE_EXT = new Set([
  'png', 'apng', 'jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'gif', 'webp',
  'bmp', 'dib', 'ico', 'cur', 'svg', 'avif',
])

/** Image formats that can carry animation AND that Chromium animates in a plain
 *  <img>. '.png' is deliberately absent: an APNG cannot be told from a still PNG
 *  without reading the file, and re-fetching every PNG at full size to find out
 *  would cost far more than the handful of APNGs in the wild are worth — an
 *  APNG renamed to .apng animates, one left as .png stays a thumbnail. */
export const ANIMATED_IMAGE_EXT = new Set(['gif', 'webp', 'avif', 'apng'])

// NOTE: '.ts' is deliberately absent — shared-mime-info calls it video/mp2t but
// in practice it is TypeScript. It goes down the text path, whose binary
// detector falls back to a thumbnail if the file really is an MPEG stream.
const VIDEO_EXT = new Set([
  'mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg',
  'mpe', 'm2v', 'm2ts', 'mts', '3gp', '3g2', 'vob', 'divx', 'asf', 'rm', 'rmvb', 'f4v',
])

const AUDIO_EXT = new Set([
  'mp3', 'flac', 'ogg', 'oga', 'opus', 'wav', 'wave', 'm4a', 'm4b', 'aac', 'mp2',
  'wma', 'aiff', 'aif', 'aifc', 'mid', 'midi', 'ape', 'wv', 'mka', 'ac3', 'dts', 'amr',
])

/** Not "every zip": .docx/.odt/.jar-as-app are zips too but listing them is noise. */
const ARCHIVE_EXT = new Set([
  'zip', 'zipx', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'tbz2', 'xz', 'txz',
  'lz', 'lzma', 'lz4', 'zst', 'tzst', 'z', 'cab', 'arj', 'lha', 'lzh', 'cpio',
  'cbz', 'cbr', 'cb7', 'iso', 'img', 'deb', 'rpm', 'pkg', 'xpi', 'crx', 'whl',
  'jar', 'war', 'ear', 'apk', 'epub',
])

const TEXT_EXT = new Set([
  'txt', 'text', 'md', 'markdown', 'rst', 'adoc', 'asciidoc', 'log', 'csv', 'tsv',
  'json', 'jsonc', 'json5', 'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf',
  'properties', 'env', 'desktop', 'service', 'rules', 'list', 'sources', 'gitignore',
  'gitattributes', 'editorconfig', 'lock', 'diff', 'patch', 'srt', 'vtt', 'sub', 'nfo',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'map', 'css', 'scss', 'sass', 'less',
  'html', 'htm', 'xhtml', 'vue', 'svelte', 'php', 'py', 'pyw', 'rb', 'pl', 'pm',
  'lua', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'awk', 'sed',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'ino', 'm', 'mm',
  'cs', 'java', 'kt', 'kts', 'scala', 'go', 'rs', 'swift', 'dart', 'r', 'jl',
  'sql', 'graphql', 'gql', 'proto', 'tex', 'bib', 'cls', 'sty',
  'make', 'mk', 'mak', 'cmake', 'gradle', 'ninja', 'dockerfile', 'containerfile',
  'vim', 'el', 'lisp', 'clj', 'cljs', 'ex', 'exs', 'erl', 'hs', 'ml', 'fs', 'fsx',
  'gd', 'gdshader', 'glsl', 'vert', 'frag', 'hlsl', 'shader', 'asm', 's', 'ld',
  'pem', 'crt', 'csr', 'pub', 'reg', 'plist', 'strings', 'po', 'pot', 'ass', 'lrc',
])

/** Extension-less files that are still text (matched on the whole name). */
const TEXT_NAMES = new Set([
  'makefile', 'dockerfile', 'containerfile', 'readme', 'license', 'licence',
  'copying', 'authors', 'changelog', 'install', 'news', 'todo', 'notice',
  'cmakelists.txt', 'jenkinsfile', 'vagrantfile', 'procfile', 'rakefile', 'gemfile',
  'pkgbuild', 'fstab', 'hosts', 'passwd', 'group', 'crontab', 'profile', 'bashrc',
])

const TEXTISH_MIME = new Set([
  'application/json', 'application/xml', 'application/javascript',
  'application/x-javascript', 'application/ecmascript', 'application/x-sh',
  'application/x-shellscript', 'application/x-perl', 'application/x-python',
  'application/x-ruby', 'application/x-desktop', 'application/x-yaml',
  'application/yaml', 'application/toml', 'application/sql', 'application/x-tex',
  'application/x-latex', 'application/xhtml+xml', 'application/rtf',
  'application/x-subrip', 'application/x-executable-script', 'image/svg+xml',
])

export interface ClassifyInput {
  isDir: boolean
  /** lowercase, no dot */
  ext: string
  mime: string
  name?: string
}

export function classifyPreview(e: ClassifyInput): PreviewKind {
  if (e.isDir) return 'folder'
  const ext = (e.ext || '').toLowerCase()
  const mime = (e.mime || '').toLowerCase()
  const name = (e.name || '').toLowerCase()

  // archives first: '.gz'/'.zst' are also "application/..." and '.epub' is a zip
  if (ARCHIVE_EXT.has(ext)) return 'archive'
  if (mime === 'application/pdf') return 'pdf'
  if (ext === 'pdf') return 'pdf'

  // svg is text AND an image — Chromium renders it, so preview it as an image
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'

  if (TEXT_EXT.has(ext)) return 'text'
  if (!ext && (TEXT_NAMES.has(name) || name.startsWith('.'))) return 'text'
  if (mime.startsWith('text/') || TEXTISH_MIME.has(mime)) return 'text'
  // extension-less and unidentified (half of /etc): try it as text — the read is
  // capped at 256 KB and the binary detector sends real binaries back to 'other'
  if (!ext && (!mime || mime === 'application/octet-stream')) return 'text'

  // extension unknown but the mime says what it is: images/videos we cannot
  // decode inline still get a thumbnail through 'other'
  if (mime.startsWith('image/')) return 'other'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'other'
}
