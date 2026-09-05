import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Legend } from '@/components/Legend'

beforeEach(() => {
  window.localStorage.clear()
})

describe('Legend', () => {
  it('names every colour that carries meaning', () => {
    render(<Legend />)
    for (const meaning of [/host address/, /router address/, /external address/, /scan-shaped/]) {
      expect(screen.getByText(meaning)).toBeTruthy()
    }
  })

  it('says the container ring is not a volume encoding', () => {
    // The one thing on the canvas that is not volume-honest has to say so.
    const { container } = render(<Legend />)
    expect(container.textContent).toMatch(/sized to fit its addresses, not by volume/)
  })

  it('folds to its header and back', () => {
    render(<Legend />)
    const toggle = screen.getByRole('button', { name: /hide the legend/i })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/host address/)).toBeVisible()

    fireEvent.click(toggle)

    const show = screen.getByRole('button', { name: /show the legend/i })
    expect(show.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText(/host address/)).not.toBeVisible()
    // Folded, it still says what it is, so it can be found again.
    expect(screen.getByText('Legend')).toBeVisible()

    fireEvent.click(show)
    expect(screen.getByText(/host address/)).toBeVisible()
  })

  it('comes back folded after a reload', () => {
    const { unmount } = render(<Legend />)
    fireEvent.click(screen.getByRole('button', { name: /hide the legend/i }))
    unmount()

    render(<Legend />)
    expect(screen.getByRole('button', { name: /show the legend/i })).toBeTruthy()
  })
})
