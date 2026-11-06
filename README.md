# @lp-labs/cost-basis-ledger

An in-memory lot ledger with FIFO or LIFO consumption. Sales are atomic: they either apply fully
or leave every lot untouched. Costs and proceeds are integer cents; partial-lot allocation uses exact
bigint arithmetic with a rounding mode you choose, and allocated amounts always add back up exactly.

## Install

```bash
npm install @lp-labs/cost-basis-ledger
```

ES2022 ESM and CommonJS builds ship with TypeScript declarations. There are no runtime dependencies.

## Quickstart

```js
import { createCostBasisLedger } from '@lp-labs/cost-basis-ledger';

const ledger = createCostBasisLedger({ method: 'fifo' });
ledger.addLot({ id: 'jan', quantity: 10n, totalCostCents: 1000n, acquiredAt: 1 });
ledger.addLot({ id: 'feb', quantity: 10n, totalCostCents: 1500n, acquiredAt: 2 });

const sale = ledger.sell({ quantity: 15n, proceedsCents: 3000n, feesCents: 30n });
if (sale.realizedGainCents !== 1220n) throw new Error('unexpected gain');
try {
  ledger.sell({ quantity: 100n, proceedsCents: 1n });
} catch (error) {
  console.log(error.code, ledger.totalQuantity()); // insufficient-quantity 5n
}
```

## API

```ts
type RoundingMode = 'floor' | 'ceil' | 'half-even' | 'half-up' | 'trunc';
type LotMethod = 'fifo' | 'lifo';
interface LedgerOptions {
  method: LotMethod;
  rounding?: RoundingMode;
  maxLots?: number;
}
interface LotInput {
  id: string;
  quantity: bigint | number;
  totalCostCents: bigint | number;
  acquiredAt: number;
}
interface Lot {
  id: string;
  quantity: bigint;
  costCents: bigint;
  acquiredAt: number;
}
interface SaleInput {
  quantity: bigint | number;
  proceedsCents: bigint | number;
  feesCents?: bigint | number;
}
interface LotAllocation {
  lotId: string;
  acquiredAt: number;
  quantity: bigint;
  costCents: bigint;
  proceedsCents: bigint;
  gainCents: bigint;
  lotExhausted: boolean;
}
interface SaleResult {
  quantity: bigint;
  proceedsCents: bigint;
  feesCents: bigint;
  netProceedsCents: bigint;
  costBasisCents: bigint;
  realizedGainCents: bigint;
  allocations: readonly LotAllocation[];
}
interface CostBasisLedger {
  addLot(lot: LotInput): void;
  previewSale(sale: SaleInput): SaleResult;
  sell(sale: SaleInput): SaleResult;
  lots(): readonly Lot[];
  totalQuantity(): bigint;
  totalCostCents(): bigint;
}
type LedgerErrorCode = 'invalid-input' | 'duplicate-lot' | 'insufficient-quantity' | 'lot-limit';
class LedgerError extends Error {
  readonly code: LedgerErrorCode;
}
function createCostBasisLedger(options: LedgerOptions): CostBasisLedger;
```

- Lots are ordered by `acquiredAt` (any safe integer you choose); equal keys follow insertion order.
  FIFO consumes the oldest first, LIFO the newest first. `lots()` lists open lots in that order.
- Quantity is whole units of whatever smallest unit you pick (for example 1e-8 coins as integers).
- A partial sale of a lot takes `round(lotCost * taken / lotQuantity)`; the final take from a lot
  takes its exact remaining cost, so no cost is ever created or lost.
- Net proceeds (`proceeds - fees`) are spread across lots by cumulative rounding so the per-lot
  proceeds sum exactly to the net amount. Gains may be negative.
- `previewSale` computes a result without applying it; `sell` applies the identical plan.

## Errors

`LedgerError` codes: `invalid-input` (bad id, quantity, cost, fees, option), `duplicate-lot`,
`insufficient-quantity` (the ledger is unchanged), `lot-limit` (default 10,000 open lots).

## Performance

Each sale sorts the open lots (`O(n log n)`) and walks only the consumed ones.

## Honest scope

This models a simple lot-selection rule only. It makes no claim to satisfy any tax authority's cost
basis rules: no wash sales, holding periods, specific identification, average cost, adjustments,
splits, or currency conversion. Do not use its output as tax advice.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
