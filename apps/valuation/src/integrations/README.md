# integrations

External systems of the valuation service (CLAUDE.md §3.2 rule 7). Used by vehicle auto-valuation, FR-14.1 / FR-14.2.

## Pattern

Each integration is a port (interface + injection token) with a mock and a real adapter. `IntegrationsModule` picks one pair at
bootstrap from `INTEGRATION_MODE` and provides it under the token. Services depend on the token only:

```ts
constructor(@Inject(VEHICLE_REGISTRY) registry: VehicleRegistry, @Inject(VEHICLE_LISTING_SOURCES) sources: VehicleListingSource[]) {}
```

| Port | Token | Mock | Real |
| --- | --- | --- | --- |
| `VehicleRegistry` (АТҮТ) | `VEHICLE_REGISTRY` | `MockVehicleRegistry` | `RealAtutVehicleRegistry` (stub) |
| `VehicleListingSource[]` (ads sites) | `VEHICLE_LISTING_SOURCES` | `MOCK_UNEGUI`, `MOCK_ADS_B` | `RealUneguiVehicleListingSource` (stub) |

Wrap every call in `callWithTimeout(integration, timeoutMs, { correlationId, now }, (ctx) => ...)`. It aborts `ctx.signal` and throws
`IntegrationError(<integration>, 'TIMEOUT')` when the deadline passes. Real adapters must honour `ctx.signal`; all adapters derive relative dates from `ctx.now`.

## INTEGRATION_MODE

| Value | Result |
| --- | --- |
| `mock` / `real` (trimmed, case-insensitive) | that mode |
| unset, `NODE_ENV` not `production` | `mock` |
| unset, `NODE_ENV=production` | startup fails: mocks must never serve production valuations |
| anything else | startup fails |

The real adapters are honest stubs that throw `IntegrationError('...', 'NOT_IMPLEMENTED')`. Their header comments list what is needed
first (agreements, specs, the ХУР-gateway question for АТҮТ). Do not guess endpoints or payloads.

## Rules for adapters

- Mocks are deterministic: no randomness, no wall clock (use `ctx.now`), no timers.
- Mock data is fictional. Never copy real owners, register numbers or prices into a fixture.
- Personal data (register number, owner name) is returned to the caller only: never log or persist it here.
- Output is validated by the service against the contract (`VehicleInfo`, `VehicleListingSchema`); a payload that does not match is reported as `BAD_RESPONSE`, so a real adapter must filter out ads it cannot normalise (no year, no numeric price).

## Adding a listing source

1. Implement `VehicleListingSource` (`id`, `search(query, ctx)`) in `listings/`, normalising `make`/`model` to the registry spelling where possible.
2. Add it to the real branch of `integrations.module.ts`. For a mock, add a seed list to `listings/mock-listings.ts` and a
   `MockVehicleListingSource` to `createMockListingSources()`.
3. Add tests next to the file. A source that fails must reject; the caller isolates it so the valuation continues with the others.

## Mock fixtures

Registry (`vehicle-registry/mock-vehicles.ts`). Digit/letter order is ignored: `УЕН5246` and `5246УЕН` are the same vehicle. Other plates return `null`.

| Plate | Vehicle | Ads in the mock sources (queried year ±1) | Expected outcome |
| --- | --- | --- | --- |
| `УЕН5246` | Toyota Prius 2012, 1798 cc, hybrid | 15, of which 2 price outliers, 1 stale, 1 other model, 1 in USD | OK, about 25-26 M MNT |
| `1234УБА` | Toyota Land Cruiser Prado 2015, 2755 cc, diesel, company owner | 8 | OK, about 85-90 M MNT |
| `5678УНА` | Hyundai Sonata 2017, 1999 cc, LPG | 5 | OK, about 30-31 M MNT |
| `7001УБЭ` | Lexus LX 570 2018, 5663 cc, petrol | 2 | not enough comparables |
| `3030БАА` | Daewoo Damas 2005, 796 cc, petrol | 0 | not enough comparables |

All names, register numbers, VINs and prices are fictional demo values (`https://example.invalid/mock/<source>/<id>` for ad URLs).
Listing postedAt is `ctx.now` minus the seed's `daysAgo`, so the data never goes stale. The search simulates a fuzzy site: a model that
merely starts with the query is returned too (`Prius Alpha` for `Prius`), so the pricing layer must reject it.
