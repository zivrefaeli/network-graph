import { beforeAll } from 'vitest'
import '@testing-library/jest-dom/vitest'

// jsdom implements no pointer capture, so any test that clicks something the
// drag path is bound to throws `setPointerCapture is not a function` from the
// handler. Vitest counts that as an unhandled error and fails the run even
// when every assertion passed, so the stub belongs here rather than in the one
// test file that happens to drag. Capture semantics are a browser concern and
// nothing under test depends on them -- these are no-ops on purpose.
//
// jsdom implements no SVG geometry either, so the matrix the drag and pan
// paths both read is stubbed with the identity transform. That makes the
// *logic* testable -- which body moves, which gesture won the pointer, where
// the viewBox ended up -- while leaving the coordinate maths itself to a real
// browser and to the pure tests in lib/viewport.test.ts.
beforeAll(() => {
  for (const name of ['setPointerCapture', 'releasePointerCapture'] as const) {
    Object.defineProperty(Element.prototype, name, { configurable: true, value: () => {} })
  }
  Object.defineProperty(Element.prototype, 'hasPointerCapture', {
    configurable: true,
    value: () => false,
  })

  const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, inverse: () => identity }
  Object.defineProperty(SVGElement.prototype, 'getScreenCTM', {
    configurable: true,
    value: () => identity,
  })

  if (!('DOMPoint' in globalThis)) {
    // Fields declared rather than passed as parameter properties, which
    // erasableSyntaxOnly bans.
    class StubPoint {
      x: number
      y: number
      constructor(x: number, y: number) {
        this.x = x
        this.y = y
      }
      matrixTransform(): StubPoint {
        return this
      }
    }
    Object.defineProperty(globalThis, 'DOMPoint', { configurable: true, value: StubPoint })
  }
})
