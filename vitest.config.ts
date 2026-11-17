import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // 缓存放到项目内：这台机器的默认临时目录不可写，vitest 在 Temp 里写 SSR 缓存会 EPERM
  cacheDir: resolve(__dirname, '.vite-cache'),
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 端到端用例会起本地假 SSH 服务端；串行跑避免端口与模块缓存竞争
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
})
