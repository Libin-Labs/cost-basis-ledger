import { createCostBasisLedger, LedgerError } from '@lp-labs/cost-basis-ledger';

const quantity: bigint = createCostBasisLedger({ method: 'lifo' }).totalQuantity();
const code: string = new LedgerError('lot-limit', 'x').code;
void [quantity, code];
