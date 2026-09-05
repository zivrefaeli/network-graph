// Mirrors app/schemas/health.py. Types only.

export interface Health {
  status: string
  /**
   * Whether the dissector the service is built around is actually present.
   * A "healthy" backend that cannot parse anything is worse than a red light.
   */
  tshark_available: boolean
  tshark_version: string | null
  tshark_error: string | null
  captures_held: number
}
