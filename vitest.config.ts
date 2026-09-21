import { defineConfig } from 'vitest/config'

// The detection pipeline is plain TypeScript with no DOM or JSX, so the test project deliberately
// skips the app's React/dev-server plugins and runs straight in Node. Tests under `src/` follow the
// same rule: only DOM-free logic (e.g. `src/feedback/form.ts`) is tested there.
export default defineConfig({
  test: {
    include: ['eval/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
})
