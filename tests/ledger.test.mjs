import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCostBasisLedger, LedgerError } from '../dist/esm/index.js';

const seeded = (method, options = {}) => {
  const ledger = createCostBasisLedger({ method, ...options });
  ledger.addLot({ id: 'jan', quantity: 10n, totalCostCents: 1000n, acquiredAt: 1 });
  ledger.addLot({ id: 'feb', quantity: 10n, totalCostCents: 1500n, acquiredAt: 2 });
  ledger.addLot({ id: 'mar', quantity: 10n, totalCostCents: 2000n, acquiredAt: 3 });
  return ledger;
};

test('FIFO consumes the oldest lots and realizes the exact gain', () => {
  const ledger = seeded('fifo');
  const sale = ledger.sell({ quantity: 15n, proceedsCents: 3000n, feesCents: 30n });
  assert.deepEqual(
    sale.allocations.map((a) => [a.lotId, a.quantity, a.costCents, a.lotExhausted]),
    [
      ['jan', 10n, 1000n, true],
      ['feb', 5n, 750n, false],
    ],
  );
  assert.equal(sale.costBasisCents, 1750n);
  assert.equal(sale.netProceedsCents, 2970n);
  assert.equal(sale.realizedGainCents, 1220n);
  assert.deepEqual(
    ledger.lots().map((l) => [l.id, l.quantity, l.costCents]),
    [
      ['feb', 5n, 750n],
      ['mar', 10n, 2000n],
    ],
  );
});

test('LIFO consumes the newest lots first regardless of insertion order', () => {
  const ledger = createCostBasisLedger({ method: 'lifo' });
  ledger.addLot({ id: 'new', quantity: 5n, totalCostCents: 500n, acquiredAt: 9 });
  ledger.addLot({ id: 'old', quantity: 5n, totalCostCents: 100n, acquiredAt: 1 });
  const sale = ledger.sell({ quantity: 7n, proceedsCents: 700n });
  assert.deepEqual(
    sale.allocations.map((a) => a.lotId),
    ['new', 'old'],
  );
  assert.equal(sale.costBasisCents, 500n + 40n);
  assert.equal(ledger.lots()[0].quantity, 3n);
  const tied = createCostBasisLedger({ method: 'fifo' });
  tied.addLot({ id: 'x', quantity: 1n, totalCostCents: 1n, acquiredAt: 5 });
  tied.addLot({ id: 'y', quantity: 1n, totalCostCents: 1n, acquiredAt: 5 });
  assert.equal(tied.sell({ quantity: 1n, proceedsCents: 1n }).allocations[0].lotId, 'x');
});

test('partial-lot cost and proceeds are allocated exactly with no lost cents', () => {
  const ledger = createCostBasisLedger({ method: 'fifo', rounding: 'floor' });
  ledger.addLot({ id: 'a', quantity: 3n, totalCostCents: 100n, acquiredAt: 1 });
  ledger.addLot({ id: 'b', quantity: 3n, totalCostCents: 100n, acquiredAt: 2 });
  const first = ledger.sell({ quantity: 1n, proceedsCents: 50n });
  assert.equal(first.costBasisCents, 33n);
  const second = ledger.sell({ quantity: 1n, proceedsCents: 50n });
  assert.equal(second.costBasisCents, 33n); // 67 cents remain over 2 units: floor(67/2)
  const rest = ledger.sell({ quantity: 4n, proceedsCents: 10n });
  assert.equal(ledger.totalQuantity(), 0n);
  assert.equal(33n + 33n + rest.costBasisCents, 200n); // total basis fully conserved
  const split = createCostBasisLedger({ method: 'fifo' });
  split.addLot({ id: 'a', quantity: 1n, totalCostCents: 0n, acquiredAt: 1 });
  split.addLot({ id: 'b', quantity: 1n, totalCostCents: 0n, acquiredAt: 2 });
  split.addLot({ id: 'c', quantity: 1n, totalCostCents: 0n, acquiredAt: 3 });
  const s = split.sell({ quantity: 3n, proceedsCents: 100n });
  assert.deepEqual(
    s.allocations.map((a) => a.proceedsCents),
    [33n, 34n, 33n],
  );
  assert.equal(
    s.allocations.reduce((t, a) => t + a.proceedsCents, 0n),
    100n,
  );
});

test('insufficient quantity is atomic: no lot is touched', () => {
  const ledger = seeded('fifo');
  const before = JSON.stringify(ledger.lots(), (k, v) => (typeof v === 'bigint' ? `${v}n` : v));
  assert.throws(
    () => ledger.sell({ quantity: 31n, proceedsCents: 1n }),
    (e) => e instanceof LedgerError && e.code === 'insufficient-quantity',
  );
  assert.equal(
    JSON.stringify(ledger.lots(), (k, v) => (typeof v === 'bigint' ? `${v}n` : v)),
    before,
  );
  assert.equal(ledger.totalQuantity(), 30n);
  // selling exactly everything succeeds afterwards
  assert.equal(ledger.sell({ quantity: 30n, proceedsCents: 0n }).costBasisCents, 4500n);
  assert.equal(ledger.lots().length, 0);
});

test('invalid sale inputs never partially deplete lots', () => {
  const ledger = seeded('lifo');
  for (const bad of [
    { quantity: 0n, proceedsCents: 1n },
    { quantity: 5n, proceedsCents: -1n },
    { quantity: 1.5, proceedsCents: 1n },
    { quantity: 5n, proceedsCents: 1n, feesCents: -1n },
    { quantity: 5n, proceedsCents: '1' },
    null,
  ]) {
    assert.throws(() => ledger.sell(bad), LedgerError);
  }
  assert.equal(ledger.totalQuantity(), 30n);
  assert.equal(ledger.totalCostCents(), 4500n);
});

test('previewSale matches sell and leaves state unchanged', () => {
  const ledger = seeded('fifo');
  const preview = ledger.previewSale({ quantity: 12n, proceedsCents: 2400n });
  assert.equal(ledger.totalQuantity(), 30n);
  const real = ledger.sell({ quantity: 12n, proceedsCents: 2400n });
  assert.deepEqual(preview, real);
  assert.equal(
    real.allocations.reduce((t, a) => t + a.gainCents, 0n),
    real.realizedGainCents,
  );
});

test('lot validation, duplicates, limits, and negative gains', () => {
  const ledger = createCostBasisLedger({ method: 'fifo', maxLots: 2 });
  const lot = { id: 'a', quantity: 2n, totalCostCents: 10n, acquiredAt: 1 };
  ledger.addLot(lot);
  assert.throws(() => ledger.addLot(lot), { code: 'duplicate-lot' });
  for (const bad of [
    { id: '' },
    { quantity: 0n },
    { totalCostCents: -1n },
    { acquiredAt: 1.5 },
    { acquiredAt: NaN },
    { quantity: 1.5 },
  ]) {
    assert.throws(() => ledger.addLot({ ...lot, id: 'z', ...bad }), LedgerError);
  }
  ledger.addLot({ ...lot, id: 'b' });
  assert.throws(() => ledger.addLot({ ...lot, id: 'c' }), { code: 'lot-limit' });
  assert.equal(ledger.sell({ quantity: 1n, proceedsCents: 0n }).realizedGainCents, -5n);
  for (const bad of [
    { method: 'avg' },
    undefined,
    { method: 'fifo', rounding: 'x' },
    { method: 'fifo', maxLots: 0 },
  ]) {
    assert.throws(() => createCostBasisLedger(bad), LedgerError);
  }
  assert.equal(
    typeof createRequire(import.meta.url)('@lp-labs/cost-basis-ledger').createCostBasisLedger,
    'function',
  );
});
