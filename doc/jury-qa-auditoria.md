# Auditoría carta por carta — flashcards del jurado (2026-06-14)

Cada respuesta clasificada honestamente:
- ✅ **CÓDIGO** = verificado en el código o on-chain (es lo que realmente hace el sistema hoy).
- 📋 **PLAN** = es el modelo/roadmap, todavía no construido o no activo.
- 🎤 **POSICIONAMIENTO** = framing de negocio/estrategia; lo confirma el founder, no se verifica en código.
- ⚠️ **AJUSTAR** = decir con cuidado / completar / matizar.

---

## Sección 1 — Lo básico
| # | Veredicto | Nota |
|---|-----------|------|
| P1 ¿Qué es WasiAI? | ✅ + 🎤 | Descubrir/componer/pagar es código real; el framing "capa de orquestación" es posicionamiento. |
| P2 ¿Qué problema? | ✅ + 🎤 | "En una sola llamada" es real (compose). |
| P3 A mi abuela | 🎤 | Analogía del demo (que es real). |
| P4 ¿Para quién? | 🎤 | Posicionamiento (marketplaces/apps). |
| P5 ¿Por qué importa? | ✅ + 🎤 | "Ya funciona" = el demo funciona. ✅ |
| P6 ¿Por qué WasiAI? | 🎤 | Hecho del equipo; lo confirma el founder. |

## Sección 2 — Producto y demo
| # | Veredicto | Nota |
|---|-----------|------|
| P7 ¿Qué construyeron? | ✅ | Gateway (descubre/compone/liquida) + demo AgentShop. Real. |
| P8 ¿Qué es AgentShop? | ✅ | Remesa, 3 agentes, liquidación verificable en KiteScan. Real. |
| P9 ¿Real o simulación? | ✅ | Tx reales en testnet. |
| P10 ¿Por qué testnet? | ✅ + 📋 | Cierto que el bloqueo es regulatorio; el "partner regulado" es plan. |
| P11 ¿Qué es un agente? | 🎤 | Definición. |
| P12 ¿1.649 tests? | ✅ | Verificado (1.059 a2a + 590 facilitator). |

## Sección 3 — Por qué Kite
| # | Veredicto | Nota |
|---|-----------|------|
| P13 ¿Por qué Kite? | ✅ | Corregido: "Kite trae los rieles". Honesto. |
| P14 ¿Qué usan de Kite? | ✅ | Corregido: x402 + settlement reales; Passport = vinculación. Honesto. |
| P15 ¿Cómo ayuda a Kite? | ✅ + ⚠️ | Cross-chain construido (real). Matiz: "con su Passport" sobre-acentúa el rol del Passport (hoy es vinculación, no auth). Decilo como "extendemos a otras redes", no "el Passport lo hace". |
| P16 ¿Qué es el Passport? | ✅ | Corregido (vinculación construida). |
| P17 ¿Qué falta? (gate) | ✅ | El `payment_target_forbidden` y el listing son reales. |
| P18 ¿Hablaron con Kite? | 🎤 | El life ya avisa: no inventar reuniones. |

## Sección 4 — Técnicas
| # | Veredicto | Nota |
|---|-----------|------|
| P19 ¿Cómo funciona? | ✅ | Flujo real. |
| P20 Componer vs orquestar | ✅ | Verificado (dos endpoints). Corregido el 1%. |
| P21 ¿Nombre inválido? | ✅ | Verificado: `compose.ts` "Agent not found", fail-closed. |
| P22 ¿Qué es x402? | ✅ | Corregido: estándar abierto, Kite nativo. |
| P23 ¿Cómo se pagan? | ✅ | Budget debit + settle (budget.ts). Real. |
| P24 ¿Es seguro? | ✅ | SSRF guard, ownership guard, fail-closed. Real en código. |
| P25 ¿Escala? | ✅ + 📋 | Gateway horizontal (real); "state channels" es de Kite; "diseñado para escalar" es aspiracional razonable. |
| P26 ¿Cross-chain? | ✅ | Honesto: construido; en vivo con wallets de demo (self-transfers). |
| P27 ¿Quién controla el dinero? | ✅ | Corregido: no-custodial, budget que el usuario retira. |
| P28 ¿Falla a la mitad? | ✅ | Fail-closed (compose.ts). Real. |
| P29 ¿Dónde está la blockchain? | ✅ | En el pago, verificable. Real. |
| P30 ¿Hashes reales? | ✅ | Verificado en KiteScan vía RPC. |
| P31 ¿Cuánto tarda? | ✅ | "Segundos" = observación real del demo (~3-5s/paso). |

## Sección 5 — Negocio y mercado
| # | Veredicto | Nota |
|---|-----------|------|
| P32 ¿Cómo ganan dinero? | ✅ + 🎤 | Fee 1% **implementado en /orchestrate** (corregido). La proyección "1.000M=10M" es posicionamiento. |
| P33 ¿Tamaño del mercado? | 🎤 | Posicionamiento (cifras de Kite). |
| P34 ¿Quién es el cliente? | 🎤 | Posicionamiento. |
| P35 ¿Cómo consiguen usuarios? | 📋 + 🎤 | GTM (remesas LATAM primero) = plan. |
| P36 ¿Competencia? | 🎤 | Posicionamiento. |
| P37 ¿No usar PayPal/Stripe? | 🎤 | Posicionamiento. |
| P38 ¿Cuánto cuesta? | ✅ + ⚠️ | El 1% existe pero hoy en /orchestrate (ver P32). Decir "1% por orquestación". |
| P39 ¿No es un wrapper? | 🎤 | Posicionamiento (analogía Uber). |
| P40 ¿Ventaja no copiable? | ✅ + 🎤 | El endurecimiento (1.649 tests, seguridad) es real; "no se copia en 3 meses" es posicionamiento. |

## Sección 6 — Tracción y estado
| # | Veredicto | Nota |
|---|-----------|------|
| P41 ¿Cuántos usuarios? | ✅ | Honesto: testnet, sin métricas infladas. |
| P42 ¿Qué es real / qué falta? | ✅ | Honesto y alineado con el código. |
| P43 ¿En producción? | ✅ | Gateway desplegado, liquidación testnet. Real. |

## Sección 7 — Regulación y riesgo
| # | Veredicto | Nota |
|---|-----------|------|
| P44 ¿Necesitan licencia? | ✅ + ⚠️ | KYC corre primero (real). PERO "el movimiento lo hace un partner regulado" es **PLAN** (todavía no hay partner, ver P52). Decir: "lo haría un partner regulado / es nuestro modelo". |
| P45 ¿Lavado (AML)? | ✅ + 📋 | El agente KYC/AML corre en el flujo (real); "antes de liquidar bloquea" es el modelo. |
| P46 ¿Qué los mata? | 🎤 | Posicionamiento (riesgo de adopción). |
| P47 ¿Por qué Kite no copia? | 🎤 | Posicionamiento. |
| P48 ¿Por qué no el marketplace? | 🎤 | Posicionamiento. |

## Sección 8 — Equipo y visión
| # | Veredicto | Nota |
|---|-----------|------|
| P49 ¿Quiénes son? | ⚠️ | **Placeholder.** Completar con bios y roles reales antes de presentar. |
| P50 Si no sabés algo técnico | 🎤 | Consejo de presentación. |
| P51 ¿En 2 años? | 🎤 + 📋 | Visión. |
| P52 ¿Con el premio? | 📋 | Plan (cerrar partner de compliance = aún no existe). |
| P53 ¿Métrica más importante? | 🎤 | Posicionamiento. |

## Sección 9 — Curveballs
| # | Veredicto | Nota |
|---|-----------|------|
| P54 30s sin jerga | 🎤 | Pitch corto (del demo real). |
| P55 ¿Lo más difícil? | ✅ + 🎤 | La coordinación segura cross-marketplace es real. |
| P56 ¿Confiar plata a IA? | ✅ | No-custodial, límites: real. |
| P57 ¿Si entrega mal? | ✅ + 📋 | Fail-closed (real); "partner regulado" cubre entrega = plan. |

---

## Resumen
- **Técnicas (P19-P31): casi todo ✅ CÓDIGO.** Es la sección más sólida; ahí podés defender con evidencia.
- **Negocio/Curveballs: 🎤 POSICIONAMIENTO.** Es estrategia, la confirma Fernando. No son "mentiras", son el plan/framing.
- **3 ⚠️ a tener presente al hablar:**
  1. **P44/P57 — "partner regulado"**: todavía NO existe (es plan). Decir "lo haría / es el modelo", no "ya lo hace".
  2. **P49 — bios**: completar con nombres/roles reales.
  3. **P15 — "con su Passport"**: el Passport hoy es vinculación, no auth. Decir "extendemos a otras redes".
- **Ya corregido en esta auditoría**: el 1% (orchestrate), la custodia (no-custodial), el Passport, x402.

**Conclusión honesta:** el material es defendible. Lo técnico está respaldado por código real; lo de negocio es posicionamiento legítimo. Los 3 ⚠️ son "decilo con cuidado", no errores graves.
