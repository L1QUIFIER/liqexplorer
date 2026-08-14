// esbuild bundling for main, preload and renderer. Usage: node bin/bundle.mjs [build|watch]
import * as esbuild from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'

const watch = process.argv[2] === 'watch'

// static assets: html + css copied as-is
function copyStatic() {
  mkdirSync('dist/renderer/styles', { recursive: true })
  cpSync('src/renderer/index.html', 'dist/renderer/index.html')
  cpSync('src/renderer/styles', 'dist/renderer/styles', { recursive: true })
}
copyStatic()

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  outbase: 'src',
  outdir: 'dist',
}

const jobs = [
  {
    ...common,
    entryPoints: ['src/main/index.ts'],
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outExtension: { '.js': '.js' },
  },
  {
    ...common,
    entryPoints: ['src/main/preload.ts'],
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: ['src/renderer/index.ts'],
    platform: 'browser',
    format: 'iife',
  },
]

if (watch) {
  const ctxs = await Promise.all(jobs.map(j => esbuild.context(j)))
  await Promise.all(ctxs.map(c => c.watch()))
  console.log('esbuild watching...')
} else {
  await Promise.all(jobs.map(j => esbuild.build(j)))
}
