import z from 'schemastery'

export const name = 'discussion-intent'

export interface Config {
  /** Enables runtime activation once all required core capabilities are present. */
  enabled: boolean
  /** Versioned host capabilities that must be negotiated before activation. */
  requiredCapabilities: string[]
}

export const Config = z.object({
  enabled: z.boolean().default(false),
  requiredCapabilities: z.array(z.string()).default([
    'cas.v1',
    'records.v1',
    'source-attestation.v1',
    'brief-run-provenance.v1',
    'ui.slots.v1',
  ]),
}) as unknown as z<Config>

/** Register the host half of the bundle. */
export function apply(_ctx: object, _config: Config): void {
  // The checked domain contract is exported from ./contract. The runtime
  // adapter is deferred until public DSH capability negotiation exists.
}
