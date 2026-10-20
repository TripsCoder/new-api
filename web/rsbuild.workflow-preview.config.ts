import path from 'node:path'

import { defineConfig } from '@rsbuild/core'
import { pluginReact } from '@rsbuild/plugin-react'
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss'

export default defineConfig({
  plugins: [pluginReact(), pluginTailwindcss({ optimize: false })],
  source: { entry: { index: './src/channel-workflow-preview.tsx' } },
  resolve: { alias: { '@': path.resolve('./src') } },
  html: { template: './index.html' },
  server: { host: '127.0.0.1', port: 13122, strictPort: true },
  output: { distPath: { root: 'dist-channel-workflow-preview' } },
})
