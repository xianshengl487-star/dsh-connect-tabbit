/**
 * Shared preflight for the two end-to-end suites.
 *
 * Both suites need the gateway holding its full roster — 20 models at startup.
 * Running either suite's refresh check collapses the gateway's own roster to one
 * model (the upstream bug documented in the README), so a second run against the
 * same gateway process would otherwise fail confusingly. Restarting the gateway
 * with a clean config.json is the fix.
 */

/** How many models the gateway currently publishes on /v1/models. */
export const modelCount = async (base) => {
  const response = await fetch(`${base}/v1/models`)
  const body = await response.json()
  return body?.data?.length ?? 0
}

/**
 * Throw an actionable error unless the gateway still holds a real roster.
 *
 * @returns the current model count when it looks healthy.
 */
export const assertFullRoster = async (base) => {
  const count = await modelCount(base)
  if (count >= 10) return count
  throw new Error([
    `the gateway reports ${count} model(s); this suite needs the full roster.`,
    '',
    'The gateway refresh (/api/admin/test-models) collapses its own catalog when',
    'it cannot authenticate against Tabbit — the upstream bug documented in the',
    'README. Restart it with a clean config and run this suite again:',
    '  rm -f config.json && uvicorn tabbit2api:app --host 127.0.0.1 --port 8800',
  ].join('\n  '))
}
