import { beforeAll } from 'vitest'
import '@testing-library/jest-dom/vitest'

// jsdom implements no pointer capture, so any test that clicks something the
// drag path is bound to throws `setPointerCapture is not a function` from the
// handler. Vitest counts that as an unhandled error and fails the run even
// when every assertion passed, so the stub belongs here rather than in the one
// test file that happens to drag. Capture semantics are a browser concern and
// nothing under test depends on them -- these are no-ops on purpose.
beforeAll(() => {
  for (const name of ['setPointerCapture', 'releasePointerCapture'] as const) {
    Object.defineProperty(Element.prototype, name, { configurable: true, value: () => {} })
  }
  Object.defineProperty(Element.prototype, 'hasPointerCapture', {
    configurable: true,
    value: () => false,
  })
})
