import {
  createCostBasisLedger,
  type CostBasisLedger,
  type SaleResult,
} from '@lp-labs/cost-basis-ledger';

const ledger: CostBasisLedger = createCostBasisLedger({ method: 'fifo', rounding: 'floor' });
ledger.addLot({ id: 'a', quantity: 10n, totalCostCents: 1000n, acquiredAt: 1 });
const sale: SaleResult = ledger.sell({ quantity: 5, proceedsCents: 900n });
const gain: bigint = sale.realizedGainCents;
void gain;
