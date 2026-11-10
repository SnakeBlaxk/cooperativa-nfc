# Pendientes — Cuitswimmer (academia de natación con tiendita)

Cuenta: **Cuitswimmer** (mismo tipo de cuenta que una escuela), `account_type = 'natacion'`.

## Hecho
- Tipo de cuenta por escuela (`schools.account_type`: `escuela` | `natacion`, por defecto `escuela`).
  Se elige en *Escuelas → Nueva escuela / Editar* ("Tipo de cuenta"). Las escuelas existentes no cambian.
- Con `natacion`, la interfaz (administrador, cajero y padres) muestra:
  - Alumno(s) → Nadador(es)
  - Escuela → Academia
  - Grado / Grupo / "Grado y grupo" → Nivel/Horario
  - Cooperativa / Tiendita escolar → Tiendita
  - Padres / Tutores: sin cambio
  Es solo texto en pantalla; datos, reportes del servidor y lógica son los mismos.
- Productos y cobro (caja) habilitados igual que en cualquier escuela.

## PENDIENTE (confirmar con el dueño antes de programar)
**Estructura de pagos de los clientes de natación.** No hay lógica implementada.

- Algunos clientes pagan **mensualidad**.
- Otros pagan **por clase asistida** (p. ej. 2 clases una semana, 1 la siguiente).

Marcador sin lógica: columna `schools.tipo_pago` (nullable) con valores previstos
`'mensualidad' | 'por_clase'`. Hoy siempre es `NULL` y nada la lee. Probablemente el dato
correcto sea **por nadador** (no por cuenta), lo cual se decidirá al confirmar con el dueño.

Preguntas para el dueño:
1. ¿El tipo de pago es por nadador o igual para toda la academia?
2. Por clase: ¿cómo se registra la asistencia (tarjeta NFC en la entrada, lista manual)? ¿Precio por clase?
3. Mensualidad: ¿monto fijo, fecha de corte, qué pasa si no se paga?
4. ¿Se descuenta del saldo de la tarjeta o se paga aparte?

## Respuestas del dueño (2 de noviembre de 2026)
Quiere tres cosas para Cuitswimmer:
1. **Registro de alumnos (nadadores)**: ya existe (alta de nadadores y padres/tutores).
2. **Mensualidades**: cobro mensual a los clientes. **Todavía NO implementado** (sin lógica de cobro;
   `schools.tipo_pago` sigue siendo solo un marcador). Siguen abiertas las preguntas de arriba.
3. **Avisos por WhatsApp**:
   - Recordatorios de pago de la mensualidad.
   - Avisos generales (anuncios de la academia).

## WhatsApp
- Hecho: campo opcional **WhatsApp** junto a *Teléfono* al registrar/editar padres/tutores y cuentas
  (registro con código, alta de tutor por el administrador, usuarios y *Cuentas* del superadministrador).
  Columna nueva `users.whatsapp` (nullable, migración `ALTER TABLE ... ADD COLUMN`, segura con datos
  existentes y Turso). Si se deja vacío se usa el teléfono (`whatsapp_effective` en la API).
  Los nadadores no tienen teléfono propio; el contacto es el del padre/tutor.
- PENDIENTE: **no hay envío de WhatsApp** (ni proveedor, ni plantillas, ni programación de recordatorios).

## Costos de mensualidad (confirmados por Canek, 2 nov 2026)
| Días por semana | Mensualidad (MXN) |
|---|---|
| 1 | 330 |
| 2 | 470 |
| 3 | 600 |
| 4 | 750 |
| 5 | 840 |
| 6 | 920 |

Inscripción: **200 MXN** (confirmado 3 nov 2026), editable en *Mensualidades → Precios de la academia*.

## Mensualidades — HECHO (3 nov 2026, solo cuentas `natacion`)
- Menú *Mensualidades* (solo administrador de academias de natación; las escuelas no lo ven ni pueden usar la API).
- En *Editar/Nuevo nadador*: **Días por semana** (1–6), **Fecha de inicio** (la elige el administrador) e **Inscripción pagada**.
- La mensualidad sale de la tabla de precios de la academia (por defecto la de arriba; editable). Inscripción por defecto 200 MXN.
- Vencimiento: cada mes el mismo día de la fecha de inicio; si el mes es más corto, el último día del mes
  (se calcula como `fecha_inicio + pagos registrados` meses, sin arrastrar días cortos).
- Estado: *Al corriente* / *Por vencer* (3 días o menos) / *Vencida*.
- Perfil del nadador → pestaña *Mensualidad*: monto, próximo vencimiento, estado, **Registrar pago** (monto prellenado,
  fecha, nota opcional; avanza un mes) e historial de pagos. Pago manual: sin cobro en línea ni descuento de saldo.
- Lista con filtro (vencidas / por vencer / al corriente / sin mensualidad / todos), con tutor y WhatsApp.
- Datos: `schools.mens_prices` (JSON, centavos), `schools.inscripcion_cents` (NULL = 200 MXN), tablas
  `swimmer_plans` y `swimmer_payments` (migraciones aditivas; sin pérdida de datos).
- Para los recordatorios por WhatsApp: RPC `mensList` con `{ status: 'vencida,por_vencer' }` devuelve
  nadador, tutor, `tutor_whatsapp`, `monthly_cents` y `next_due`.

## WhatsApp automático — HECHO (WAHA, no Meta)
- Cliente WAHA (`WAHA_URL`, `WAHA_API_KEY`, `WAHA_SESSION`). Sin esas variables no se envía nada.
- **Configuración → WhatsApp** (administrador): activar o pausar, hora diaria en `America/Mexico_City`, estado de la sesión y enlace al QR.
- Cada día, a esa hora: mensualidades **por vencer** o **vencidas**, un mensaje por tutor y nadador (nombre, monto, fecha). No se repite el mismo día.
- Las mismas notificaciones que ya salen en la app (compra, compra rechazada —incluye tarjeta bloqueada—, saldo bajo) se copian por WhatsApp si el tutor tiene teléfono y los avisos están activos.
- El teléfono del tutor se edita en el alumno (10 dígitos de México).
- Guía de Docker / segundo servicio en Render y del QR: [`docs/whatsapp-waha.md`](whatsapp-waha.md).

## Pendiente
- Pago por clase suelta (si se requiere).
- (Hecho 3 nov 2026) Editar y borrar pagos registrados por error desde el historial del nadador (con confirmación; el vencimiento regresa un mes; borrado lógico con quién/cuándo).
- (Hecho) Botón *💬 Ayuda* (administrador y cajero, todas las cuentas): panel con **Preguntas frecuentes** (buscador; adaptadas
  a los términos de la cuenta) y **Hablar con la IA** (`POST /api/help/chat`, solo sobre el uso de Zuki Pay, en español y breve;
  límite 20 preguntas/hora por cuenta). Siempre ofrece *Escribir a soporte por WhatsApp* (+52 56 5862 9519).
  **Para activar la IA en Render:** `ZUKIPAY_AI_API_KEY` (llave de OpenAI o API compatible; también acepta `OPENAI_API_KEY`).
  Opcionales: `ZUKIPAY_AI_MODEL` (por defecto `gpt-4o-mini`) y `ZUKIPAY_AI_BASE_URL` (por defecto `https://api.openai.com/v1`).
  Sin llave, el chat muestra un mensaje amable y el enlace de WhatsApp.
