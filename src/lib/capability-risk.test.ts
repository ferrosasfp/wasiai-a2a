/**
 * R-4 — la clasificación de capacidades, medida contra los nombres REALES del
 * catálogo.
 *
 * ⚠️ NINGÚN test de este archivo itera `DISBURSEMENT_CAPABILITIES` para después
 * preguntarle a `classifyCapability` si sus elementos son de desembolso: eso
 * comprueba que un `Set` se contiene a sí mismo y sobrevive a cualquier cambio de
 * la lista. Los nombres se escriben a mano, uno por uno, copiados de la evidencia
 * que los publica:
 *
 *   · `doc/sdd/170-wkh-172-remit-cashout-payout/done-report.md:202` — las 4 del
 *     agente de payout;
 *   · `doc/sdd/167-wkh-171-remit-corridor-fx/done-report.md:177` — las 3 del FX;
 *   · `doc/sdd/169-wkh-170-remit-kyc-validator/done-report.md:190` — las 4 del KYC.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyCapabilities,
  classifyCapability,
  needsTightTrialQuota,
} from './capability-risk.js';

describe('R-4 · qué capacidades DESEMBOLSAN', () => {
  it.each([
    'remittance-payout',
    'cashout',
    'value-delivery',
    'fiat-disbursement',
  ])('`%s` (registro de `remit-cashout-payout`) es DESEMBOLSO', (capability) => {
    expect(classifyCapability(capability)).toBe('disbursement');
  });

  it.each([
    'remittance-fx-quote',
    'usdc-to-pen',
    'corridor-pricing',
    'kyc-verification',
    'aml-screening',
    'travel-rule',
    'remittance-compliance',
  ])('`%s` (cotizar / validar) NO es desembolso', (capability) => {
    expect(classifyCapability(capability)).toBe('no-disbursement');
  });

  it('mayúsculas y espacios NO esquivan la clasificación', () => {
    // Sin normalizar, publicar `Remittance-Payout` compraba el cupo ancho con un
    // cambio de una tecla. El filtro de capabilities de discovery ya compara en
    // minúsculas (`services/discovery.ts:445-450`), así que un agente puede
    // declararlo así y seguir siendo encontrado por la misma búsqueda.
    expect(classifyCapability('Remittance-Payout')).toBe('disbursement');
    expect(classifyCapability('  VALUE-DELIVERY  ')).toBe('disbursement');
  });

  it('lo que no está en ninguna lista es `unclassified`, NO "inocuo"', () => {
    // `cashout-match` está en el catálogo (`doc/sdd/_INDEX.md:144`) y se dejó
    // AFUERA de la lista de inocuas a propósito: nombra un cashout y no se pudo
    // verificar que no entregue valor.
    expect(classifyCapability('cashout-match')).toBe('unclassified');
    expect(classifyCapability('lo-que-sea-que-publiquen-manana')).toBe(
      'unclassified',
    );
  });
});

describe('R-4 · la clasificación del AGENTE (todas sus capacidades)', () => {
  it('una sola capacidad de desembolso alcanza: el que además cotiza sigue siendo el que paga', () => {
    expect(
      classifyCapabilities(['remittance-fx-quote', 'remittance-payout']),
    ).toBe('disbursement');
  });

  it('todas verificadas inocuas → `no-disbursement` (el único caso que afloja el cupo)', () => {
    expect(classifyCapabilities(['remittance-fx-quote', 'usdc-to-pen'])).toBe(
      'no-disbursement',
    );
  });

  it('una sola sin clasificar contamina al conjunto', () => {
    expect(classifyCapabilities(['remittance-fx-quote', 'algo-nuevo'])).toBe(
      'unclassified',
    );
  });

  it.each([
    ['lista vacía', [] as unknown[]],
    ['sin capacidades (undefined)', undefined],
    ['null', null],
    ['entradas que no son strings', [{ nombre: 'payout' }, 42]],
    ['un string suelto en vez de arreglo', 'remittance-fx-quote' as never],
  ])('%s → `unclassified`: "no dice qué hace" NO es "no mueve plata"', (_caso, capabilities) => {
    expect(classifyCapabilities(capabilities)).toBe('unclassified');
  });
});

describe('R-4 · el lado seguro de lo desconocido', () => {
  it('desembolso y desconocido comparten el cupo ESTRECHO; sólo lo verificado-inocuo escapa', () => {
    // La decisión explícita: una capacidad nueva que mueva plata y que nadie haya
    // agregado a la lista recibe igual el cupo más restrictivo. Equivocarse en esta
    // dirección le aprieta el carril a un agente inocuo; equivocarse en la otra
    // entrega el `depositAddress` de una remesa.
    expect(needsTightTrialQuota(['remittance-payout'])).toBe(true);
    expect(needsTightTrialQuota(['una-capacidad-que-nadie-listo'])).toBe(true);
    expect(needsTightTrialQuota([])).toBe(true);
    expect(needsTightTrialQuota(['remittance-fx-quote'])).toBe(false);
  });
});

describe('T-CAP · WKH-225 — las 2 capacidades del camino hospedado del KYC', () => {
  // Los nombres se copian A MANO del sitio que los publica,
  // `wasiai-remittance-agents/src/manifest/registry.ts:76-77`, no de la lista
  // que este archivo verifica.
  it('T-CAP-1: `kyc-hosted-redirect` es no-disbursement', () => {
    expect(classifyCapability('kyc-hosted-redirect')).toBe('no-disbursement');
  });

  it('T-CAP-2: `legacy-single-shot-kyc` es no-disbursement', () => {
    expect(classifyCapability('legacy-single-shot-kyc')).toBe(
      'no-disbursement',
    );
  });

  it('T-CAP-3: las 6 capacidades REALES de remit-kyc-validator NO caen al cupo estrecho', () => {
    // 🔴 ÉSTE es el test con efecto medido, y los otros dos son su andamio.
    // Las 6 son las que el manifiesto declara HOY, en ese orden
    // (`registry.ts:66-77`): 4 nombran el ROL, 2 nombran el CAMINO.
    const LAS_SEIS = [
      'kyc-verification',
      'aml-screening',
      'travel-rule',
      'remittance-compliance',
      'kyc-hosted-redirect',
      'legacy-single-shot-kyc',
    ];
    expect(classifyCapabilities(LAS_SEIS)).toBe('no-disbursement');
    expect(needsTightTrialQuota(LAS_SEIS)).toBe(false);

    // Y la prueba de que el test no es vacuo: sacando las dos nuevas de la
    // lista clasificada, el conjunto REAL volvería al cupo estrecho. Eso es lo
    // que pasaba antes de esta HU.
    expect(
      needsTightTrialQuota([...LAS_SEIS, 'una-septima-sin-clasificar']),
    ).toBe(true);
  });

  it('agregar estas dos NO afloja nada más: `cashout-match` sigue afuera', () => {
    // Sigue sin poder verificarse que no entregue valor, y un "probablemente
    // no" no entra a una lista cuyo efecto es AFLOJAR un cupo del camino del
    // dinero.
    expect(classifyCapability('cashout-match')).toBe('unclassified');
    expect(needsTightTrialQuota(['cashout-match'])).toBe(true);
  });
});
