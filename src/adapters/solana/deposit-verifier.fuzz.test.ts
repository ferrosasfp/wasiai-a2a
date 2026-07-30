import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const MINT = vi.hoisted(() => '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const st = vi.hoisted(() => vi.fn());
const gtx = vi.hoisted(() => vi.fn());
vi.mock('./chain.js', () => ({
  getSolanaConnection: () => ({
    getSignatureStatuses: st,
    getParsedTransaction: gtx,
  }),
  getSolanaUsdcMint: () => MINT,
  getSolanaUsdcDecimals: () => 6,
}));

import { verifySolanaDeposit } from './deposit-verifier.js';

const OWNER = Keypair.generate().publicKey.toBase58();
const DEP = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();
const OUR = getAssociatedTokenAddressSync(
  new PublicKey(MINT),
  new PublicKey(OWNER),
).toBase58();
const DEPATA = getAssociatedTokenAddressSync(
  new PublicKey(MINT),
  new PublicKey(DEP),
).toBase58();
const SECOND = Keypair.generate().publicKey.toBase58();

interface Row {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number;
    uiAmountString: string;
  };
}
const row = (i: number, o: string, a: string): Row => ({
  accountIndex: i,
  mint: MINT,
  owner: o,
  uiTokenAmount: { amount: a, decimals: 6, uiAmount: 0, uiAmountString: a },
});

/** DEPOSITO REAL: 1 USDC. Tesoreria tenia 1000. */
const REAL = 1000000n;
const base = () => ({
  pre: [row(1, DEP, '10000000'), row(2, OWNER, '1000000000')],
  post: [row(1, DEP, '9000000'), row(2, OWNER, '1001000000')],
});
const KEYS = [DEP, DEPATA, OUR, SECOND];

const build = (pre: Row[], post: Row[], keys: string[] = KEYS) => ({
  meta: { err: null, preTokenBalances: pre, postTokenBalances: post },
  transaction: {
    message: {
      accountKeys: keys.map((k, i) => ({
        pubkey: new PublicKey(k),
        signer: i === 0,
        writable: true,
      })),
    },
  },
});

const AMOUNTS = ['0', '1', '5000000', '1000000000', '1001000000', '999999999'];
const OWNERS = [OWNER, DEP, OTHER];
const INDEXES = [0, 1, 2, 3];

/** Todas las mutaciones de UNA fila sobre el dataset base. */
function singleMutations(): { label: string; tx: unknown }[] {
  const out: { label: string; tx: unknown }[] = [];
  for (const side of ['pre', 'post'] as const) {
    for (let i = 0; i < 2; i++) {
      const mk = (f: (rows: Row[]) => Row[]) => {
        const b = base();
        const rows = f(b[side].map((r) => ({ ...r })));
        return side === 'pre' ? build(rows, b.post) : build(b.pre, rows);
      };
      out.push({
        label: `${side}[${i}] borrada`,
        tx: mk((r) => r.filter((_, j) => j !== i)),
      });
      out.push({
        label: `${side}[${i}] duplicada`,
        tx: mk((r) => [...r, { ...(r[i] as Row) }]),
      });
      for (const a of AMOUNTS) {
        out.push({
          label: `${side}[${i}].amount=${a}`,
          tx: mk((r) => {
            const c = [...r];
            c[i] = {
              ...(r[i] as Row),
              uiTokenAmount: { ...(r[i] as Row).uiTokenAmount, amount: a },
            };
            return c;
          }),
        });
      }
      for (const o of OWNERS) {
        out.push({
          label: `${side}[${i}].owner=${o.slice(0, 6)}`,
          tx: mk((r) => {
            const c = [...r];
            c[i] = { ...(r[i] as Row), owner: o };
            return c;
          }),
        });
      }
      out.push({
        label: `${side}[${i}].owner ausente`,
        tx: mk((r) => {
          const c = [...r];
          const { owner: _o, ...rest } = r[i] as Row;
          c[i] = rest as Row;
          return c;
        }),
      });
      out.push({
        label: `${side}[${i}].mint=otro`,
        tx: mk((r) => {
          const c = [...r];
          c[i] = { ...(r[i] as Row), mint: SECOND };
          return c;
        }),
      });
      for (const idx of INDEXES) {
        out.push({
          label: `${side}[${i}].accountIndex=${idx}`,
          tx: mk((r) => {
            const c = [...r];
            c[i] = { ...(r[i] as Row), accountIndex: idx };
            return c;
          }),
        });
      }
      for (const idx of INDEXES) {
        for (const a of ['1000000000', '1001000000']) {
          out.push({
            label: `${side} + fila inyectada idx=${idx} amount=${a}`,
            tx: mk((r) => [...r, row(idx, OTHER, a)]),
          });
        }
      }
    }
  }
  // accountKeys mutados
  out.push({
    label: 'keys: OUR duplicada',
    tx: build(base().pre, base().post, [DEP, DEPATA, OUR, OUR]),
  });
  out.push({
    label: 'keys: truncadas',
    tx: build(base().pre, base().post, [DEP, DEPATA]),
  });
  out.push({
    label: 'keys: OUR reemplazada',
    tx: build(base().pre, base().post, [DEP, DEPATA, SECOND, SECOND]),
  });
  return out;
}

describe('FUZZ it5: ninguna mutación de filas puede INFLAR el crédito', () => {
  beforeEach(() => {
    process.env.A2A_DEPOSIT_OWNER_SOLANA = OWNER;
    process.env.A2A_DEPOSIT_ENABLED_SOLANA = 'true';
    st.mockResolvedValue({
      value: [
        {
          slot: 1,
          confirmations: null,
          err: null,
          confirmationStatus: 'finalized',
        },
      ],
    });
  });

  it('andamiaje: el dataset base acredita EXACTAMENTE 1 USDC', async () => {
    const b = base();
    gtx.mockResolvedValue(build(b.pre, b.post));
    const res = await verifySolanaDeposit({ signature: 'sig' });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.amountAtomic).toBe(REAL);
  });

  it('UNA fila mutada: cero inflaciones', async () => {
    const muts = singleMutations();
    expect(muts.length).toBeGreaterThan(90);
    const inflations: string[] = [];
    for (const m of muts) {
      gtx.mockResolvedValue(m.tx);
      const res = await verifySolanaDeposit({ signature: 'sig' });
      if (res.ok && res.amountAtomic > REAL) {
        inflations.push(`${m.label} ⇒ ${res.amountAtomic}`);
      }
    }
    expect(
      inflations,
      `${inflations.length} inflaciones sobre ${muts.length} mutaciones:\n${inflations.join('\n')}`,
    ).toEqual([]);
    // Andamiaje del propio fuzz: el barrido tiene que haber EJERCITADO el verificador.
    expect(muts.length).toBe(103);
  });

  it('DOS filas mutadas: cero inflaciones', async () => {
    const muts = singleMutations();
    const inflations: string[] = [];
    let n = 0;
    for (let i = 0; i < muts.length; i++) {
      for (let j = i + 1; j < muts.length; j++) {
        // combinar: aplicar la mutación j sobre el resultado de i es caro; se combinan
        // los datasets tomando pre de uno y post del otro, que es la forma de
        // truncación/corrupción cruzada que produjo CE1 y REPRO F.
        const a = muts[i]?.tx as { meta: { preTokenBalances: Row[] } };
        const b = muts[j]?.tx as {
          meta: { postTokenBalances: Row[] };
          transaction: unknown;
        };
        n++;
        gtx.mockResolvedValue({
          meta: {
            err: null,
            preTokenBalances: a.meta.preTokenBalances,
            postTokenBalances: b.meta.postTokenBalances,
          },
          transaction: b.transaction,
        });
        const res = await verifySolanaDeposit({ signature: 'sig' });
        if (res.ok && res.amountAtomic > REAL) {
          inflations.push(
            `${muts[i]?.label} × ${muts[j]?.label} ⇒ ${res.amountAtomic}`,
          );
        }
      }
    }
    expect(
      inflations,
      `${inflations.length} inflaciones sobre ${n} pares:\n${inflations.slice(0, 10).join('\n')}`,
    ).toEqual([]);
    expect(n).toBe(5253);
  });
});
