/**
 * Pointer helpers shared by the two gestures the canvas supports: dragging a
 * body, and panning the view. Both need the same slop threshold and the same
 * screen-to-user-space conversion, and a second copy of either is a bug
 * waiting to happen -- a pan measured in raw client pixels would move by the
 * wrong distance the moment the view was zoomed.
 */

/**
 * A press that moves less than this counts as a click, not a drag. Without it,
 * finishing a gesture would also act on whatever was under the pointer:
 * selecting the body just moved, or clearing the selection at the end of a pan.
 */
export const DRAG_SLOP_PX = 4

export interface UserPoint {
  x: number
  y: number
}

/** Maps client coordinates into the svg's user space. */
export type UserSpaceMapper = (clientX: number, clientY: number) => UserPoint

/**
 * Freezes the svg's screen-to-user matrix and returns a mapper over it.
 *
 * A pan must use one matrix from start to finish. Panning rewrites the
 * viewBox, which rewrites the matrix, so re-reading it mid-gesture would
 * measure each move against a space the previous move had just shifted, and
 * the canvas would accelerate away from the cursor. Dragging a body is the
 * opposite case and deliberately re-reads the live matrix: it maps the cursor
 * to a graph point, and if the view moves underneath, the new mapping is the
 * right one.
 *
 * jsdom implements no SVG geometry and hands back no matrix; falling back to
 * the raw coordinates keeps the gesture logic testable there.
 */
export function userSpaceMapper(svg: SVGSVGElement | null): UserSpaceMapper {
  const ctm = svg?.getScreenCTM()
  if (ctm === null || ctm === undefined) {
    return (clientX, clientY) => ({ x: clientX, y: clientY })
  }
  const inverse = ctm.inverse()
  return (clientX, clientY) => {
    const point = new DOMPoint(clientX, clientY).matrixTransform(inverse)
    return { x: point.x, y: point.y }
  }
}

/** One-shot conversion against the matrix as it stands right now. */
export function toUserPoint(
  svg: SVGSVGElement | null,
  clientX: number,
  clientY: number,
): UserPoint {
  return userSpaceMapper(svg)(clientX, clientY)
}
