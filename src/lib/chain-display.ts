/**
 * Presentación de redes para superficies de lectura (WKH-191x).
 *
 * Traduce los identificadores CRUDOS que quedan en la telemetría
 * (`a2a_receipts.chain_id` numérico y `a2a_receipts.settle_caip2` CAIP-2) al
 * nombre legible + explorer de la chain, resolviéndolos SIEMPRE contra el
 * registry real de adapters (`getInitializedChainKeys` / `getAdaptersBundle`),
 * nunca contra una tabla de nombres propia. Si mañana entra un rail nuevo, esta
 * capa lo muestra sin tocar una línea.
 *
 * Usa `getAdaptersBundle` (que devuelve `undefined` si el registry no está
 * inicializado) y NO `getChainConfig` (que lanza): una pantalla de observabilidad
 * nunca debe caerse porque el registry todavía no arrancó.
 */

import {
  getAdaptersBundle,
  getInitializedChainKeys,
} from '../adapters/registry.js';

/** Red resuelta para mostrar. `key === null` = no la tenemos registrada. */
export interface ChainDisplay {
  /** Slug del registry (`avalanche-fuji`, `solana-devnet`, …) o `null`. */
  key: string | null;
  /** Nombre legible (`Avalanche Fuji`). Fallback honesto si no se resolvió. */
  label: string;
  /** Base del explorer de la chain, o `null` si no la conocemos. */
  explorerUrl: string | null;
}

function unresolved(label: string): ChainDisplay {
  return { key: null, label, explorerUrl: null };
}

/**
 * `chain_id` numérico → red. Cubre los dos casos: los chainIds EVM reales y el
 * sentinel sintético de Solana (DT-8, `chainConfig.chainId` del bundle Solana),
 * porque los dos viven en la MISMA columna `a2a_receipts.chain_id`.
 */
export function describeChainId(chainId: number | null): ChainDisplay {
  if (chainId === null || !Number.isFinite(chainId)) {
    return unresolved('red no registrada');
  }
  for (const key of getInitializedChainKeys()) {
    const bundle = getAdaptersBundle(key);
    if (bundle?.chainConfig.chainId === chainId) {
      return {
        key,
        label: bundle.chainConfig.name,
        explorerUrl: bundle.chainConfig.explorerUrl,
      };
    }
  }
  // Honesto: el rail existió cuando se escribió el recibo pero hoy no está
  // cargado en este proceso (o el recibo es de otra config).
  return unresolved(`chain ${String(chainId)}`);
}

/**
 * `settle_caip2` (`solana:<genesis-prefix>`) → red, comparando contra el
 * `caip2ChainId` que declara el payment adapter no-EVM del bundle.
 */
export function describeCaip2(caip2: string | null): ChainDisplay {
  if (!caip2) return unresolved('red no registrada');
  for (const key of getInitializedChainKeys()) {
    const bundle = getAdaptersBundle(key);
    const payment = bundle?.payment;
    if (
      payment &&
      payment.vmFamily !== 'evm' &&
      payment.caip2ChainId === caip2
    ) {
      return {
        key,
        label: bundle.chainConfig.name,
        explorerUrl: bundle.chainConfig.explorerUrl,
      };
    }
  }
  // Fallback: el CAIP-2 crudo. Es un identificador público (va en la respuesta
  // de /compose), así que mostrarlo no filtra nada.
  return unresolved(caip2);
}

/**
 * URL de la transacción en el explorer de su red.
 *
 * Inserta `/tx/<hash>` en el PATH, preservando el query string de la base: el
 * explorer de Solana se configura como `https://explorer.solana.com?cluster=devnet`
 * (`adapters/solana/index.ts`), así que una concatenación cruda produciría
 * `…?cluster=devnet/tx/<sig>`, que no resuelve. Devuelve `null` cuando no hay
 * explorer conocido o el hash está vacío: la UI muestra el hash sin link antes
 * que un link roto.
 */
export function buildExplorerTxUrl(
  explorerUrl: string | null,
  hash: string | null,
): string | null {
  if (!explorerUrl || !hash) return null;
  try {
    const url = new URL(explorerUrl);
    const base = url.pathname.replace(/\/+$/, '');
    url.pathname = `${base}/tx/${encodeURIComponent(hash)}`;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * ¿El caller pagó en una red y el agente cobró en otra? Esa es la tesis del
 * producto, así que se decide comparando REDES RESUELTAS, no strings:
 *
 *  - sin `settle_caip2` → no hay segundo rail declarado ⇒ no es cruce.
 *  - `settle_caip2` que resuelve a la MISMA chain que `chain_id` (un caller con
 *    budget Solana pagando un agente Solana) ⇒ NO es cruce.
 *  - cualquier otro caso con `settle_caip2` presente ⇒ SÍ es cruce.
 *
 * Cuando ninguno de los dos resuelve (`key === null` en ambos) se compara el
 * identificador crudo para no inventar un cruce entre dos desconocidos iguales.
 */
export function isCrossChainSettle(
  chainId: number | null,
  settleCaip2: string | null,
): boolean {
  if (!settleCaip2) return false;
  const paid = describeChainId(chainId);
  const collected = describeCaip2(settleCaip2);
  if (paid.key !== null && collected.key !== null) {
    return paid.key !== collected.key;
  }
  return paid.label !== collected.label;
}
