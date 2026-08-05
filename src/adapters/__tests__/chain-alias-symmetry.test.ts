/**
 * Simetría de alias de red — el alias BARE no puede apuntar a dinero real.
 *
 * Hallazgo: `avalanche` caía a testnet (Fuji) pero `base` caía a MAINNET
 * (chainId 8453). Quien escribía `base` esperando el mismo criterio que
 * `avalanche` apuntaba a una red con dinero real, y el error era SILENCIOSO: no
 * falla, settlea contra la cadena equivocada.
 *
 * ⚠️ CRITERIO DE ESTOS TESTS: los valores esperados son LITERALES escritos a
 * mano acá, traídos desde afuera del módulo. NINGUNO se recalcula con la misma
 * expresión que usa el código (nada de `isMainnetChainKey(k)` ni
 * `k.endsWith('-mainnet')` del lado del test): un test que recalcula la
 * fórmula que vigila aplaude cualquier fórmula, incluida la rota.
 */
import { describe, expect, it } from 'vitest';

import {
  getCanonicalChainId,
  isAmbiguousChainAlias,
  listChainAliases,
  normalizeChainSlug,
} from '../chain-resolver.js';

/**
 * Tabla EXHAUSTIVA alias → destino. Los tres valores de cada fila son literales
 * escritos a mano (ChainKey, chainId y entorno), NO derivados del módulo.
 */
const ALIAS_TABLE: ReadonlyArray<{
  alias: string;
  chainKey: string;
  chainId: number | 'non-evm';
  environment: 'mainnet' | 'testnet';
  ambiguous: boolean;
}> = [
  // ── avalanche ──
  {
    alias: 'avalanche',
    chainKey: 'avalanche-fuji',
    chainId: 43113,
    environment: 'testnet',
    ambiguous: true,
  },
  {
    alias: 'avalanche-fuji',
    chainKey: 'avalanche-fuji',
    chainId: 43113,
    environment: 'testnet',
    ambiguous: false,
  },
  {
    alias: 'avalanche-testnet',
    chainKey: 'avalanche-fuji',
    chainId: 43113,
    environment: 'testnet',
    ambiguous: false,
  },
  {
    alias: 'fuji',
    chainKey: 'avalanche-fuji',
    chainId: 43113,
    environment: 'testnet',
    ambiguous: false,
  },
  {
    alias: '43113',
    chainKey: 'avalanche-fuji',
    chainId: 43113,
    environment: 'testnet',
    ambiguous: false,
  },
  {
    alias: 'avalanche-mainnet',
    chainKey: 'avalanche-mainnet',
    chainId: 43114,
    environment: 'mainnet',
    ambiguous: false,
  },
  {
    alias: '43114',
    chainKey: 'avalanche-mainnet',
    chainId: 43114,
    environment: 'mainnet',
    ambiguous: false,
  },

  // ── base ── ★ el alias BARE es el que cambió: antes caía en 8453 (mainnet).
  {
    alias: 'base',
    chainKey: 'base-sepolia',
    chainId: 84532,
    environment: 'testnet',
    ambiguous: true,
  },
  {
    alias: 'base-sepolia',
    chainKey: 'base-sepolia',
    chainId: 84532,
    environment: 'testnet',
    ambiguous: false,
  },
  {
    alias: 'base-testnet',
    chainKey: 'base-sepolia',
    chainId: 84532,
    environment: 'testnet',
    ambiguous: false,
  },
  {
    alias: '84532',
    chainKey: 'base-sepolia',
    chainId: 84532,
    environment: 'testnet',
    ambiguous: false,
  },
  {
    alias: 'base-mainnet',
    chainKey: 'base-mainnet',
    chainId: 8453,
    environment: 'mainnet',
    ambiguous: false,
  },
  {
    alias: '8453',
    chainKey: 'base-mainnet',
    chainId: 8453,
    environment: 'mainnet',
    ambiguous: false,
  },

  // ── kite ── (no tiene alias BARE: `kite` a secas no se reconoce)
  {
    alias: 'kite-ozone-testnet',
    chainKey: 'kite-ozone-testnet',
    chainId: 2368,
    environment: 'testnet',
    ambiguous: false,
  },
  {
    alias: 'kite-testnet',
    chainKey: 'kite-ozone-testnet',
    chainId: 2368,
    environment: 'testnet',
    ambiguous: false,
  },
  {
    alias: '2368',
    chainKey: 'kite-ozone-testnet',
    chainId: 2368,
    environment: 'testnet',
    ambiguous: false,
  },
  {
    alias: 'kite-mainnet',
    chainKey: 'kite-mainnet',
    chainId: 2366,
    environment: 'mainnet',
    ambiguous: false,
  },
  {
    alias: '2366',
    chainKey: 'kite-mainnet',
    chainId: 2366,
    environment: 'mainnet',
    ambiguous: false,
  },

  // ── tempo ──
  {
    alias: 'tempo',
    chainKey: 'tempo-testnet',
    chainId: 42429,
    environment: 'testnet',
    ambiguous: true,
  },
  {
    alias: 'tempo-testnet',
    chainKey: 'tempo-testnet',
    chainId: 42429,
    environment: 'testnet',
    ambiguous: false,
  },
  {
    alias: '42429',
    chainKey: 'tempo-testnet',
    chainId: 42429,
    environment: 'testnet',
    ambiguous: false,
  },

  // ── solana ──
  {
    alias: 'solana',
    chainKey: 'solana-devnet',
    chainId: 'non-evm',
    environment: 'testnet',
    ambiguous: true,
  },
  {
    alias: 'solana-devnet',
    chainKey: 'solana-devnet',
    chainId: 'non-evm',
    environment: 'testnet',
    ambiguous: false,
  },
];

/**
 * Los ÚNICOS alias autorizados a resolver a una red de dinero real. Lista
 * literal, escrita a mano: cada uno DICE `mainnet` en su nombre o es el chainId
 * numérico exacto de esa mainnet. No se deriva de ninguna función del módulo.
 */
const ALIASES_ALLOWED_TO_REACH_MAINNET: readonly string[] = [
  'avalanche-mainnet',
  '43114',
  'base-mainnet',
  '8453',
  'kite-mainnet',
  '2366',
];

/** chainIds de dinero real. Literales — no salen de `EVM_CHAIN_ENVIRONMENT`. */
const MAINNET_CHAIN_IDS: readonly number[] = [43114, 8453, 2366];

describe('simetría de alias — tabla alias → destino', () => {
  it.each(
    ALIAS_TABLE,
  )("'$alias' → $chainKey (chainId $chainId, $environment)", ({
    alias,
    chainKey,
    chainId,
  }) => {
    expect(normalizeChainSlug(alias)).toBe(chainKey);
    // El chainId se compara contra el literal de la fila, no contra el mapa
    // del módulo, así que un cambio del mapa canónico también rompe acá.
    expect(getCanonicalChainId(chainKey as never)).toBe(chainId);
  });

  it('la tabla cubre TODOS los alias del resolver (un alias nuevo sin fila rompe)', () => {
    const tabulated = ALIAS_TABLE.map((r) => r.alias).sort();
    expect(listChainAliases().sort()).toEqual(tabulated);
  });
});

describe('★ el caso `base` — comportamiento nuevo', () => {
  it('`base` a secas resuelve a base-sepolia (TESTNET), NO a base-mainnet', () => {
    expect(normalizeChainSlug('base')).toBe('base-sepolia');
    expect(normalizeChainSlug('base')).not.toBe('base-mainnet');
  });

  it('`base` apunta al chainId 84532, no al 8453 (dinero real)', () => {
    const key = normalizeChainSlug('base');
    expect(key).toBeDefined();
    expect(getCanonicalChainId(key as never)).toBe(84532);
    expect(getCanonicalChainId(key as never)).not.toBe(8453);
  });

  it('escribir mainnet explícitamente sigue funcionando: `base-mainnet` y `8453` → base-mainnet', () => {
    expect(normalizeChainSlug('base-mainnet')).toBe('base-mainnet');
    expect(normalizeChainSlug('8453')).toBe('base-mainnet');
  });

  it('mayúsculas y espacios no reabren el camino a mainnet', () => {
    expect(normalizeChainSlug('BASE')).toBe('base-sepolia');
    expect(normalizeChainSlug('  Base  ')).toBe('base-sepolia');
  });

  it('`base` queda simétrico con sus hermanos bare (todos testnet)', () => {
    // El hallazgo original en una sola línea: los cuatro bare aliases tienen
    // que coincidir en entorno. Valores literales, uno por uno.
    expect(normalizeChainSlug('avalanche')).toBe('avalanche-fuji');
    expect(normalizeChainSlug('base')).toBe('base-sepolia');
    expect(normalizeChainSlug('tempo')).toBe('tempo-testnet');
    expect(normalizeChainSlug('solana')).toBe('solana-devnet');
  });
});

describe('invariante de seguridad — ningún alias llega a mainnet sin decirlo', () => {
  it('por ENUMERACIÓN: sólo los alias de la allowlist literal resuelven a un chainId mainnet', () => {
    const reachMainnet: string[] = [];
    for (const alias of listChainAliases()) {
      const key = normalizeChainSlug(alias);
      expect(key, `alias '${alias}' no resuelve`).toBeDefined();
      const cid = getCanonicalChainId(key as never);
      if (typeof cid === 'number' && MAINNET_CHAIN_IDS.includes(cid)) {
        reachMainnet.push(alias);
      }
    }
    expect(reachMainnet.sort()).toEqual(
      [...ALIASES_ALLOWED_TO_REACH_MAINNET].sort(),
    );
  });

  it('NINGÚN alias ambiguo (nombre pelado de red) llega a mainnet', () => {
    for (const alias of listChainAliases()) {
      if (!isAmbiguousChainAlias(alias)) continue;
      const cid = getCanonicalChainId(normalizeChainSlug(alias) as never);
      expect(
        typeof cid === 'number' && MAINNET_CHAIN_IDS.includes(cid),
        `alias ambiguo '${alias}' resuelve a un chainId de dinero real (${String(cid)})`,
      ).toBe(false);
    }
  });
});

describe('isAmbiguousChainAlias — clasificación (primera mitad de la postura C)', () => {
  it.each(ALIAS_TABLE)("'$alias' ambiguo=$ambiguous", ({
    alias,
    ambiguous,
  }) => {
    expect(isAmbiguousChainAlias(alias)).toBe(ambiguous);
  });

  it('los cuatro alias ambiguos son exactamente base/avalanche/tempo/solana', () => {
    expect(listChainAliases().filter(isAmbiguousChainAlias).sort()).toEqual([
      'avalanche',
      'base',
      'solana',
      'tempo',
    ]);
  });

  it('un string que no es alias no es ambiguo (incl. `kite`, namespace sin alias bare)', () => {
    expect(isAmbiguousChainAlias('kite')).toBe(false);
    expect(isAmbiguousChainAlias('polygon')).toBe(false);
    expect(isAmbiguousChainAlias('')).toBe(false);
  });

  it('normaliza caso y espacios igual que el resolver', () => {
    expect(isAmbiguousChainAlias('  BASE  ')).toBe(true);
    expect(isAmbiguousChainAlias('Avalanche')).toBe(true);
  });

  it('CD-19 — no alcanza las keys de Object.prototype', () => {
    expect(isAmbiguousChainAlias('toString')).toBe(false);
    expect(isAmbiguousChainAlias('constructor')).toBe(false);
    expect(isAmbiguousChainAlias('__proto__')).toBe(false);
  });

  it('NO rechaza: clasificar un alias como ambiguo no impide resolverlo', () => {
    // La segunda mitad (rechazo) está declarada, no construida: hoy 16 de los
    // 25 agentes del catálogo vivo declaran `avalanche`.
    for (const alias of listChainAliases().filter(isAmbiguousChainAlias)) {
      expect(normalizeChainSlug(alias)).toBeDefined();
    }
  });
});
