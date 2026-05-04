# Operator Identities Runbook — wasiai-a2a

**Owner**: Fernando Rosas (`ferrosasfp@gmail.com`)
**Status**: vigente
**Last updated**: 2026-05-01 (WKH-80)
**Audience**: cualquier operador que tenga que asumir el control de wasiai-a2a-production sin conocimiento previo

---

## Propósito

Centralizar TODAS las identidades operacionales conocidas del servicio
`wasiai-a2a` (wallets, cuentas Kite Passport, proyectos cloud, base de datos)
con su **ID público**, **ubicación del secret**, **procedimiento de recovery**
y **owner activo**. El objetivo es eliminar el bus factor de "todo está en la
cabeza/laptop de una sola persona" sin commitear ningún secret en el repo.

Si encontrás este documento por primera vez y necesitás operar el sistema,
empezá por la tabla principal en la sección 2 — todo lo demás expande sobre
filas de esa tabla.

## Scope

### Cubre

- Operator wallet usado para outbound payments (Avalanche)
- Cuentas Kite Passport (prod + staging) creadas en el spike WKH-68
- Proyectos cloud productivos: Vercel, Railway, Supabase
- Email raíz asociado a todas las cuentas anteriores

### NO cubre

- Identidades de `wasiai-v2` (marketplace) — vive en otro repo, otro runbook
- Cuentas de proveedores externos genéricos (GitHub, Anthropic, etc.) que no
  tocan el plano de pagos
- Ejecución de la migración v2→a2a — eso vive en
  `/home/ferdev/.openclaw/workspace/wasiai-a2a/doc/migration/RUNBOOK-prod-execution.md`
- Rotación de keys / scripts automatizados de recuperación — fuera de scope
  para WKH-80 (candidato a HU futura)

---

## 1. Tabla principal de identidades

| Identity Name | Public ID | Secret Location | Recovery Procedure | Owner |
|---------------|-----------|-----------------|--------------------|-------|
| Operator wallet (outbound, Avalanche) | `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba` | Railway env `OPERATOR_PRIVATE_KEY` (service `wasiai-a2a-production`) | Re-importar la private key en Railway Variables; ver sección 4 | Fernando |
| Kite Passport — prod (user) | `user_019de709-4367-7d4f-b21f-f188b7aff8db` | `~/.openclaw/workspace/wasiai-a2a/.kite-passport/config.json` (gitignored) | Re-login vía email + JWT regen; ver sección 3 | Fernando |
| Kite Passport — prod (agent) | `agent_019de70b-dcef-7e5b-86c4-b34c51c71205` (`agent_type: orchestrator-router`) | `~/.openclaw/workspace/wasiai-a2a/.kite-passport/agent.json` (gitignored) | Re-register tras login; ver sección 3 | Fernando |
| Kite Passport — prod (wallet) | `0x7aB8760225Ffd90F23bd0B5BfC5B04965976AdB3` (chain `2366` Kite mainnet) | Provisioned por Passport — la private key NO sale de Passport | Provisioning automático al re-login; ver sección 3 | Fernando |
| Kite Passport — staging (user) | `user_019de70e-ed4f-7216-a1f5-fd31b43474ab` | `/tmp/kpass-staging-poc/.kite-passport/config.json` (efímero, NO persistido) | Re-signup completo desde cero en `passport.staging.gokite.ai`; ver sección 3 | Fernando |
| Kite Passport — staging (agent) | `agent_019de710-15c5-7154-80ee-19f81499ec05` (`agent_type: orchestrator-router`) | `/tmp/kpass-staging-poc/.kite-passport/agent.json` (efímero) | Re-register tras re-signup; ver sección 3 | Fernando |
| Kite Passport — staging (wallet) | `0xEB696D493339A759BEaE0d735F5aA313B8e90810` (chain `2366`) | Provisioned por Passport (staging backend) | Re-provisioning automático al re-signup; ver sección 3 | Fernando |
| Vercel project — marketplace proxy | `wasiai-prod` | Vercel dashboard (login con email raíz) | Login en `vercel.com` con `ferrosasfp@gmail.com`; CLI `vercel login` | Fernando |
| Vercel project — MCP x402 | `wasiai-x402-mcp` | Vercel dashboard (mismo login) | Login en `vercel.com` con `ferrosasfp@gmail.com`; CLI `vercel login` | Fernando |
| Railway service — A2A backend | `wasiai-a2a-production` | Railway dashboard + env vars (`OPERATOR_PRIVATE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `WASIAI_V2_FORWARD_KEY`, etc.) | Login en `railway.app` con email raíz; `railway variables --service wasiai-a2a-production` | Fernando |
| Railway service — facilitator | `wasiai-facilitator-production` | Railway dashboard (sin secrets propios actualmente) | Login en `railway.app` con email raíz | Fernando |
| Supabase project — prod DB | `caldzjhjgctpgodldqav` | Supabase dashboard; service-role key vive en Railway env `SUPABASE_SERVICE_ROLE_KEY` | Login en `supabase.com` con email raíz; rotar service-role key desde Settings → API | Fernando |
| Email raíz | `ferrosasfp@gmail.com` | Gmail account (2FA personal) | Recovery de Google Account; única defensa contra pérdida de TODOS los servicios anteriores | Fernando |

> **Nota CD-1**: ningún valor de secret (JWT, agent_token, PRIVATE_KEY,
> FORWARD_KEY, SERVICE_ROLE_KEY, API key) aparece en este documento ni en
> ningún archivo trackeado por git. Solo IDs públicos, paths a secrets y
> nombres de env vars.

---

## 2. Recovery flow — Kite Passport

Esta sección permite a un operador nuevo reconstruir el acceso a las cuentas
Kite Passport (prod o staging) desde cero, asumiendo que tiene acceso al
**email raíz** `ferrosasfp@gmail.com` y nada más.

Los comandos `kpass` están copiados verbatim del spike WKH-68
(`/home/ferdev/.openclaw/workspace/wasiai-a2a/doc/sdd/spike-kite-passport/poc-results.md`,
sección "Onboarding flow") y adaptados al contexto de recovery. Los valores
de `<email>`, `<8CHARS>` y `<signup_id>` son placeholders — los reales se
reciben por mail al ejecutar `signup init`.

### Pre-requisitos

```bash
sudo apt install jq  # el installer de kpass falla sin jq (POC friction #1)
curl -fsSL https://agentpassport.ai/install.sh | bash
# binario en ~/.kpass/bin/, symlink en ~/.local/bin/kpass
```

> **Friction conocida**: el directorio de config se llama `.kite-passport/`
> aunque la documentación oficial diga `.kpass/` (POC friction #3).
> Por eso este runbook siempre referencia `.kite-passport/`.

### Recovery — Prod (`passport.prod.gokite.ai`, chain `2366` Kite mainnet)

> **Importante CD-4**: el `cwd` define la identidad — todo el flujo se ejecuta
> desde el mismo directorio donde queremos que viva el secret.

```bash
# 0. Posicionarse en el directorio destino del secret (gitignored)
cd ~/.openclaw/workspace/wasiai-a2a
# .kite-passport/ aparecerá como subdir tras el step 2

# 1. Iniciar signup con el email raíz
kpass signup init --email ferrosasfp@gmail.com --client agent --output json --no-interactive
# → revisar inbox de ferrosasfp@gmail.com
# → click verification link en el primer email
# → tomar el 8-char code del segundo email (formato: 8 caracteres alfanuméricos)
# → guardar el signup_id devuelto en stdout (ej. signup_019de709-...)

# 2. Intercambiar el code por el JWT
KPASS_SIGNUP_CODE=<8CHARS> kpass signup exchange --signup-id <signup_id> --output json
# → JWT guardado en ./.kite-passport/config.json
# → user_id devuelto debe matchear user_019de709-4367-7d4f-b21f-f188b7aff8db
#   (si no matchea: la cuenta fue migrada/recreada — actualizar este runbook)

# 3. Re-registrar el agent (mismo type que en spike WKH-68)
kpass agent:register --type orchestrator-router --output json
# → agent token guardado en ./.kite-passport/agent.json
# → agent_id devuelto debe matchear agent_019de70b-dcef-7e5b-86c4-b34c51c71205

# 4. Verificar wallet (auto-provisioned, balance 0 inicial)
kpass wallet balance --output json
# → wallet debe matchear 0x7aB8760225Ffd90F23bd0B5BfC5B04965976AdB3
# → chain_id 2366 (Kite mainnet)
```

**Tiempo total**: ~3 min (excluyendo la espera del email).
**Pasos manuales requeridos**: click en verification link + copy del 8-char code.

### Recovery — Staging (`passport.staging.gokite.ai`)

> **Caveat DT-2 (efímero)**: el secret location actual es `/tmp/kpass-staging-poc/`,
> que NO persiste entre reboots. El runbook **recomienda** crear una ubicación
> persistente como mejora futura
> (ej. `~/.openclaw/workspace/.kite-passport-staging/`), pero **esa decisión
> no es parte de WKH-80**. Hasta que se decida, staging se trata como
> "regenerable bajo demanda" siguiendo los pasos de abajo.

```bash
# 0. Posicionarse en cwd staging (re-creable)
mkdir -p /tmp/kpass-staging-poc && cd /tmp/kpass-staging-poc

# 1. Apuntar kpass a backend staging (mecanismo: env o flag — verificar
#    versión instalada con `kpass --help`. En el spike WKH-68 el switch fue
#    a través del backend env del CLI, NO documentado oficialmente —
#    POC friction #6).

# 2. Signup en staging (mismo email)
kpass signup init --email ferrosasfp@gmail.com --client agent --output json --no-interactive
# → revisar inbox; el segundo email contiene el code de staging (distinto del de prod)
KPASS_SIGNUP_CODE=<8CHARS> kpass signup exchange --signup-id <signup_id> --output json
# → user_id devuelto será NUEVO (no necesariamente igual a user_019de70e-...);
#   los IDs registrados en la tabla son los del spike. Tras un re-signup, los
#   IDs cambian y este runbook DEBE actualizarse.

# 3. Re-registrar agent
kpass agent:register --type orchestrator-router --output json

# 4. Verificar wallet
kpass wallet balance --output json
```

> **Friction conocida (POC #2)**: el faucet de staging devuelve
> "missing authorization header" pese a que la documentación dice "(no auth)".
> No bloquea el recovery del access — solo bloquea el fondeo. El POC original
> dejó la wallet staging con balance 0; esto es esperado.

### Recovery del flujo de session (para ambos envs)

Una vez que la cuenta está recuperada, para ejecutar transacciones x402 se
necesita una `agent:session` aprobada por humano vía passkey:

```bash
kpass agent:session create \
  --task-summary "<descripción libre que aparece en la pantalla de approval>" \
  --max-amount-per-tx 0.1 \
  --max-total-amount 0.5 \
  --ttl 1h \
  --assets USDC \
  --output json
# → devuelve approval_url + request_id + status: human_action_required
# → abrir approval_url en el browser, autenticar con passkey, aprobar

kpass agent:session status --request-id <request_id> --wait
# → polling hasta que status: approved
```

Sin paso de approval humano, la session queda bloqueada en
`human_action_required` y NO se puede ejecutar `agent:session execute`.
Esto es by-design de Passport (no hay headless approval).

---

## 3. Bus Factor — identidades con dependencia de persona única

Esta sección es la razón principal por la que existe este runbook. Toda
identidad listada abajo depende **exclusivamente** de Fernando Rosas como
owner activo. Si Fernando deja de estar disponible, el sistema queda
inoperable hasta que se ejecuten los recovery flows desde el email raíz.

| Identidad | Dependencia | Riesgo | Mitigación propuesta (WKH futuro) |
|-----------|-------------|--------|-----------------------------------|
| Operator wallet (`0xf432...447Ba`) | Private key existe SOLO en Railway env y en el laptop de Fernando | Alto — pérdida = imposibilidad de cobrar outbound a downstreams | Multi-sig wallet (Safe) con 2-de-3 firmantes; rotar `OPERATOR_PRIVATE_KEY` en Railway tras setup |
| Kite Passport — prod | JWT + agent token en `~/.openclaw/.../wasiai-a2a/.kite-passport/` (laptop personal) | Medio — recovery posible vía email + passkey, pero requiere acceso a `ferrosasfp@gmail.com` | Documentar passkey backup en password manager compartido del equipo; agregar segundo dispositivo Passport autorizado |
| Kite Passport — staging | Secret en `/tmp/` efímero | Bajo — staging es regenerable sin pérdida de valor económico | Mover a `~/.openclaw/workspace/.kite-passport-staging/` persistente (ver caveat DT-2 sección 3); decisión propia HU |
| Email raíz `ferrosasfp@gmail.com` | Gmail personal de Fernando + 2FA personal | **Crítico** — si se pierde, se pierden TODOS los recoveries de la tabla anterior | Migrar a cuenta corporativa (`ops@<dominio>`) con backup codes en password manager compartido; mantener Gmail actual como secundario hasta que la migración esté validada |
| Vercel projects (`wasiai-prod`, `wasiai-x402-mcp`) | Login con email raíz | Medio — heredan el riesgo del email | Agregar a Fernando + un segundo team member como owners en Vercel |
| Railway services (`wasiai-a2a-production`, `wasiai-facilitator-production`) | Login con email raíz + env vars | Medio — heredan el riesgo del email; los secrets se pueden rotar pero requieren acceso al panel | Agregar segundo team member con rol Admin en Railway |
| Supabase project (`caldzjhjgctpgodldqav`) | Login con email raíz; service-role key en Railway | Medio — pérdida del email = pérdida del DB; backups solo en Supabase | Agregar segundo team member como owner; configurar backups externos periódicos |

### Acción recomendada (no parte de WKH-80)

Crear épica **WKH-OPS-MULTI-OWNER** que cubra: multi-sig wallet operator +
segundo owner en Vercel/Railway/Supabase + cuenta de email corporativo.
Hasta que esa épica avance, este runbook + acceso al email raíz son la
**única** defensa contra bus factor.

---

## 4. Operator Wallet — flujo outbound Avalanche

**Public address**: `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba`
**Env var**: `OPERATOR_PRIVATE_KEY` en Railway service `wasiai-a2a-production`

### Rol en el sistema

El operator wallet es el firmante de **todos los pagos outbound** que
`wasiai-a2a` emite hacia downstream agents. En el modelo Hybrid (Modelo B
discutido en el spike WKH-68 — ver `poc-results.md` sección "Architectural
implications for Modelo B"):

- **Inbound** (cliente → wasiai-a2a): puede ser pagado por el cliente
  directamente (EOA) o por una Passport session wallet. wasiai-a2a recibe
  x402 normalmente.
- **Outbound** (wasiai-a2a → N downstream agents en Avalanche): SIEMPRE
  firmado con `OPERATOR_PRIVATE_KEY`. Esto es la "Stripe Connect half" del
  análogo: settlement multi-party que Passport no cubre.

El `OPERATOR_PRIVATE_KEY` controla **directamente** los fondos USDC que
viven en `0xf432...447Ba` en Avalanche. No hay otro guardián.

### Ubicación del secret

- **Producción runtime**: env var `OPERATOR_PRIVATE_KEY` en Railway
  service `wasiai-a2a-production`. Acceso vía:
  ```bash
  railway variables --service wasiai-a2a-production
  ```
  (NO loguear el valor — Railway lo muestra como `***` por defecto en CLI
  reciente; verificar antes de ejecutar comandos en presencia de terceros).
- **Local de Fernando**: la private key original existe en una ubicación
  fuera del repo (no documentada acá por CD-1). Cualquier rotación nueva
  debe usar `openssl` o equivalente offline y guardarse en password manager.

### Recovery procedure

1. Acceder al password manager de Fernando con la private key actual
   (única fuente de la verdad fuera de Railway).
2. `railway login` con `ferrosasfp@gmail.com`.
3. `railway variables --service wasiai-a2a-production set OPERATOR_PRIVATE_KEY=<valor>`.
4. Verificar redeploy automático del servicio.
5. Smoke-test: ejecutar un orchestrate end-to-end y confirmar que el outbound
   payment se firma correctamente desde `0xf432...447Ba`.

> **Pérdida total**: si la private key se pierde Y el password manager NO
> tiene backup, los fondos en `0xf432...447Ba` quedan **irrecuperables**
> (chain inmutable). La migración a multi-sig (sección 4 — Bus Factor)
> elimina este riesgo.

### Cross-references al uso del wallet

- `OPERATOR_PRIVATE_KEY` es consumido por el código de outbound payment del
  servicio `wasiai-a2a-production` — el flujo concreto vive en `src/` y NO
  se documenta en este runbook (que es operacional, no arquitectónico).
- El runbook de migración v2→a2a
  (`/home/ferdev/.openclaw/workspace/wasiai-a2a/doc/migration/RUNBOOK-prod-execution.md`)
  asume que `OPERATOR_PRIVATE_KEY` ya está seteado en Railway antes de
  ejecutar la canary toggle.

---

## 5. Documentos relacionados

- **Fuente primaria de IDs Passport**:
  `/home/ferdev/.openclaw/workspace/wasiai-a2a/doc/sdd/spike-kite-passport/poc-results.md`
  — spike WKH-68. Contiene los `user_id`/`agent_id`/`wallet` originales de
  prod y staging, los comandos `kpass` verbatim que sirven de base para el
  recovery flow de la sección 3, y el análisis arquitectónico de la
  delegation structure.

- **Runbook de ejecución de migración v2→a2a**:
  `/home/ferdev/.openclaw/workspace/wasiai-a2a/doc/migration/RUNBOOK-prod-execution.md`
  — alcance acotado: la migración puntual del 2026-04-28. Asume que las
  identidades operacionales ya están configuradas (no las documenta).

### Gap que WKH-80 cierra

Antes de WKH-80 existían dos documentos:

1. `poc-results.md` — IDs de Kite Passport, pero como artefacto de un spike
   técnico, sin formato operacional ni recovery procedure.
2. `RUNBOOK-prod-execution.md` — pasos de ejecución de migración, pero
   asumiendo que el operador YA tiene las credenciales en mano.

**Ninguno** centralizaba TODAS las identidades operacionales (operator
wallet + Passport prod + Passport staging + cloud services + DB) en una
única tabla con `Public ID | Secret Location | Recovery Procedure | Owner`.
Tampoco existía un análisis de bus factor consolidado.

Este runbook (`doc/operations/identities-runbook.md`) cierra ese gap como
pieza independiente de cualquier migración puntual, con vida útil indefinida.

---

## 6. Caveats abiertos

- **DT-2 — Staging persistence**: el secret location de staging
  (`/tmp/kpass-staging-poc/`) es efímero. La recomendación de migrar a
  `~/.openclaw/workspace/.kite-passport-staging/` persistente NO es decisión
  de WKH-80 — queda como mejora propuesta para una HU futura. Hasta tanto,
  staging se regenera siguiendo la sección 3.

- **Cuentas adicionales** (resuelto en F2): WKH-80 documenta SOLO las cuentas
  Passport confirmadas en `poc-results.md` (prod + staging). NO se inventan
  ambientes dev/local. Si se crea un nuevo ambiente, este runbook DEBE
  actualizarse (no es opcional).

- **Rotación automática**: este runbook describe el estado y el recovery
  manual. Scripts automatizados de rotación de keys son scope de una HU
  futura (candidato: épica `WKH-OPS-MULTI-OWNER`).
