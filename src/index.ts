export type RoundingMode = 'floor' | 'ceil' | 'half-even' | 'half-up' | 'trunc';
export type LotMethod = 'fifo' | 'lifo';

export interface LedgerOptions {
  readonly method: LotMethod;
  /** Rounding for partial-lot cost and proceeds allocation. Defaults to `half-even`. */
  readonly rounding?: RoundingMode;
  /** Maximum open lots. Defaults to 10000. */
  readonly maxLots?: number;
}

export interface LotInput {
  readonly id: string;
  /** Positive whole quantity in the caller's smallest unit. */
  readonly quantity: bigint | number;
  /** Total acquisition cost of the whole lot in cents. */
  readonly totalCostCents: bigint | number;
  /** Ordering key: any finite integer (e.g. epoch milliseconds or a day number). */
  readonly acquiredAt: number;
}

export interface Lot {
  readonly id: string;
  readonly quantity: bigint;
  readonly costCents: bigint;
  readonly acquiredAt: number;
}

export interface SaleInput {
  readonly quantity: bigint | number;
  readonly proceedsCents: bigint | number;
  readonly feesCents?: bigint | number;
}

export interface LotAllocation {
  readonly lotId: string;
  readonly acquiredAt: number;
  readonly quantity: bigint;
  readonly costCents: bigint;
  readonly proceedsCents: bigint;
  readonly gainCents: bigint;
  readonly lotExhausted: boolean;
}

export interface SaleResult {
  readonly quantity: bigint;
  readonly proceedsCents: bigint;
  readonly feesCents: bigint;
  readonly netProceedsCents: bigint;
  readonly costBasisCents: bigint;
  readonly realizedGainCents: bigint;
  readonly allocations: readonly LotAllocation[];
}

export interface CostBasisLedger {
  addLot(lot: LotInput): void;
  /** Computes a sale against current lots without changing the ledger. */
  previewSale(sale: SaleInput): SaleResult;
  /** Applies a sale atomically: on any error the ledger is unchanged. */
  sell(sale: SaleInput): SaleResult;
  /** Open lots in consumption order for the configured method. */
  lots(): readonly Lot[];
  totalQuantity(): bigint;
  totalCostCents(): bigint;
}

export type LedgerErrorCode =
  'invalid-input' | 'duplicate-lot' | 'insufficient-quantity' | 'lot-limit';

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

const MODES: readonly RoundingMode[] = ['floor', 'ceil', 'half-even', 'half-up', 'trunc'];

function divRound(n: bigint, d: bigint, mode: RoundingMode): bigint {
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const negative = n < 0n;
  const away = negative ? q - 1n : q + 1n;
  const twice = (r < 0n ? -r : r) * 2n;
  switch (mode) {
    case 'trunc':
      return q;
    case 'floor':
      return negative ? away : q;
    case 'ceil':
      return negative ? q : away;
    case 'half-up':
      return twice >= d ? away : q;
    case 'half-even':
      return twice > d || (twice === d && q % 2n !== 0n) ? away : q;
  }
}

function integer(value: unknown, name: string, minimum: bigint): bigint {
  let result: bigint;
  if (typeof value === 'bigint') result = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) result = BigInt(value);
  else throw new LedgerError('invalid-input', `${name} must be a bigint or safe integer.`);
  if (result < minimum)
    throw new LedgerError('invalid-input', `${name} must be at least ${minimum}.`);
  return result;
}

interface Entry {
  id: string;
  quantity: bigint;
  costCents: bigint;
  acquiredAt: number;
  sequence: number;
}

export function createCostBasisLedger(options: LedgerOptions): CostBasisLedger {
  if (options?.method !== 'fifo' && options?.method !== 'lifo') {
    throw new LedgerError('invalid-input', "method must be 'fifo' or 'lifo'.");
  }
  const method = options.method;
  const rounding = options.rounding ?? 'half-even';
  if (!MODES.includes(rounding)) throw new LedgerError('invalid-input', 'Unknown rounding mode.');
  const maxLots = options.maxLots ?? 10000;
  if (!Number.isInteger(maxLots) || maxLots < 1 || maxLots > 1_000_000) {
    throw new LedgerError('invalid-input', 'maxLots must be an integer from 1 to 1000000.');
  }
  let entries: Entry[] = [];
  let sequence = 0;

  // Earliest first for fifo, latest first for lifo; ties follow insertion order.
  const ordered = (list: readonly Entry[]): Entry[] =>
    [...list].sort((a, b) => {
      const byDate = method === 'fifo' ? a.acquiredAt - b.acquiredAt : b.acquiredAt - a.acquiredAt;
      return byDate !== 0
        ? byDate
        : method === 'fifo'
          ? a.sequence - b.sequence
          : b.sequence - a.sequence;
    });

  const view = (entry: Entry): Lot =>
    Object.freeze({
      id: entry.id,
      quantity: entry.quantity,
      costCents: entry.costCents,
      acquiredAt: entry.acquiredAt,
    });

  function plan(sale: SaleInput): { result: SaleResult; next: Entry[] } {
    const quantity = integer(sale?.quantity, 'quantity', 1n);
    const proceeds = integer(sale?.proceedsCents, 'proceedsCents', 0n);
    const fees = sale?.feesCents === undefined ? 0n : integer(sale.feesCents, 'feesCents', 0n);
    const net = proceeds - fees;
    const queue = ordered(entries);
    const held = queue.reduce((total, entry) => total + entry.quantity, 0n);
    if (quantity > held) {
      throw new LedgerError(
        'insufficient-quantity',
        `Sale of ${quantity} exceeds the ${held} held.`,
      );
    }
    const allocations: LotAllocation[] = [];
    const remaining = new Map<string, Entry>();
    let left = quantity;
    let consumed = 0n;
    let allocatedProceeds = 0n;
    let totalCost = 0n;
    for (const entry of queue) {
      if (left === 0n) break;
      const take = entry.quantity < left ? entry.quantity : left;
      const exhausted = take === entry.quantity;
      const cost = exhausted
        ? entry.costCents
        : divRound(entry.costCents * take, entry.quantity, rounding);
      consumed += take;
      // Cumulative rounding makes the per-lot proceeds sum to the net exactly.
      const cumulative = consumed === quantity ? net : divRound(net * consumed, quantity, rounding);
      const share = cumulative - allocatedProceeds;
      allocatedProceeds = cumulative;
      totalCost += cost;
      left -= take;
      allocations.push(
        Object.freeze({
          lotId: entry.id,
          acquiredAt: entry.acquiredAt,
          quantity: take,
          costCents: cost,
          proceedsCents: share,
          gainCents: share - cost,
          lotExhausted: exhausted,
        }),
      );
      if (!exhausted) {
        remaining.set(entry.id, {
          ...entry,
          quantity: entry.quantity - take,
          costCents: entry.costCents - cost,
        });
      } else remaining.set(entry.id, { ...entry, quantity: 0n });
    }
    const next = entries
      .map((entry) => remaining.get(entry.id) ?? entry)
      .filter((entry) => entry.quantity > 0n);
    return {
      next,
      result: Object.freeze({
        quantity,
        proceedsCents: proceeds,
        feesCents: fees,
        netProceedsCents: net,
        costBasisCents: totalCost,
        realizedGainCents: net - totalCost,
        allocations: Object.freeze(allocations),
      }),
    };
  }

  return {
    addLot(lot: LotInput): void {
      if (typeof lot?.id !== 'string' || lot.id === '' || lot.id.length > 256) {
        throw new LedgerError(
          'invalid-input',
          'Lot id must be a non-empty string of at most 256 characters.',
        );
      }
      const quantity = integer(lot.quantity, 'quantity', 1n);
      const cost = integer(lot.totalCostCents, 'totalCostCents', 0n);
      if (!Number.isSafeInteger(lot.acquiredAt)) {
        throw new LedgerError('invalid-input', 'acquiredAt must be a safe integer.');
      }
      if (entries.some((entry) => entry.id === lot.id)) {
        throw new LedgerError('duplicate-lot', `Lot ${lot.id} already exists.`);
      }
      if (entries.length >= maxLots)
        throw new LedgerError('lot-limit', `At most ${maxLots} open lots.`);
      sequence += 1;
      entries.push({ id: lot.id, quantity, costCents: cost, acquiredAt: lot.acquiredAt, sequence });
    },
    previewSale: (sale) => plan(sale).result,
    sell(sale: SaleInput): SaleResult {
      const { result, next } = plan(sale);
      entries = next;
      return result;
    },
    lots: () => Object.freeze(ordered(entries).map(view)),
    totalQuantity: () => entries.reduce((total, entry) => total + entry.quantity, 0n),
    totalCostCents: () => entries.reduce((total, entry) => total + entry.costCents, 0n),
  };
}
