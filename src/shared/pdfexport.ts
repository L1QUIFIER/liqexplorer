// "Save this PDF as pictures" — the contract between main and the renderer.
//
// The push channel is declared HERE rather than in shared/ipc.ts's PUSH table
// on purpose: that table is being edited by other work, and a feature that can
// register its own channel has no reason to make a shared file busier. The
// string still follows the 'liqpush:' convention the preload enforces.
export const PDF_EXPORT_PROGRESS = 'liqpush:pdf-export'

/**
 * A format this machine can genuinely write.
 *
 * `vector` matters more than it looks. A PDF is not a picture — it is drawing
 * instructions — so exporting one to SVG or EPS keeps it resolution-independent
 * and rasterising it first would throw that away for nothing. Those formats
 * therefore skip the raster path entirely, and DPI does not apply to them.
 */
export interface PdfExportFormat {
  /** output extension, e.g. 'png' */
  id: string
  label: string
  /** written by poppler direct, or rasterised then re-encoded */
  backend: 'poppler' | 'magick' | 'ffmpeg'
  vector: boolean
  /** quality/compression is meaningful */
  lossy: boolean
  /** can hold every page in ONE file */
  multipage: boolean
}

export interface PdfExportRequest {
  /** the PDF */
  src: string
  /** destination FOLDER; the names are derived from the document */
  dest: string
  format: string
  /** rasterisation resolution; ignored for vector formats */
  dpi: number
  /** 1-based, inclusive. Omit for the whole document. */
  from?: number
  to?: number
  /**
   * Keep the page background transparent instead of painting it white.
   *
   * A PDF page has no background of its own, so a PNG exported from one is
   * transparent unless something fills it — which looks like a bug the first
   * time a "blank" page opens somewhere that shows transparency as black.
   * White is therefore the default and this is the opt-out.
   */
  transparent?: boolean
  /** 1..100 for lossy formats */
  quality?: number
  /** stack every page into a single tall image instead of one file per page */
  combine?: boolean
}

export interface PdfExportProgress {
  runId: number
  status: 'running' | 'done' | 'cancelled' | 'error'
  done: number
  total: number
  /** basename being written */
  current: string
  /** paths actually written (capped for the wire; `written` is not) */
  outputs: string[]
  written: number
  error?: string
}

/** DPI presets, with what each is actually for. */
export const PDF_DPI_PRESETS: { dpi: number; label: string; note: string }[] = [
  { dpi: 96, label: 'Screen', note: 'smallest files' },
  { dpi: 150, label: 'Good', note: 'sharp on screen' },
  { dpi: 300, label: 'Print', note: 'what printers want' },
  { dpi: 600, label: 'Maximum', note: 'large files' },
]

/** an A4 page at this DPI, so the size of the request is not a surprise */
export function estimatePixels(dpi: number): string {
  const w = Math.round(8.27 * dpi)
  const h = Math.round(11.69 * dpi)
  return `${w} × ${h}`
}
