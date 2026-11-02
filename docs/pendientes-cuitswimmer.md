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

Notificaciones de WhatsApp: no se tocaron.
