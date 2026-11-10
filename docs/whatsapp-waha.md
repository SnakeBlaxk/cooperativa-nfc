# WhatsApp automático con WAHA (sin API de Meta)

Los avisos de Cuitswimmer salen por **WAHA** (motor **GOWS**): un WhatsApp vinculado como "dispositivo" a un número propio de la academia. No se usa la API de WhatsApp Business de Meta ni sus tokens. Es una conexión **no oficial**: si se mandan muchos mensajes a gente que no tiene guardado el número, WhatsApp puede bloquearlo.

## Qué hace

1. **Recordatorios de mensualidad**: una vez al día, a la hora elegida (Ciudad de México), al tutor de cada mensualidad **por vencer** (3 días o menos) o **vencida**. No se repite el mismo día.
2. **Copia de avisos de la app**: compra, compra rechazada y saldo bajo, si el tutor tiene teléfono.
3. **Aviso general** (nuevo): el administrador escribe un mensaje y lo manda a todos los papás/tutores con teléfono. Pide confirmación, empieza con "Hola" + nombre del tutor, sale uno por uno (30 s entre mensajes por defecto) y queda el registro de enviados y fallidos.

Todo en **Configuración → WhatsApp**.

## Cómo corre (mismo servicio de Render, sin costo extra)

El `Dockerfile` usa la imagen oficial `devlikeapro/waha:gows-<versión>` (Node 24) y le agrega Zuki Pay. `server/start.js` es el proceso de Zuki Pay y además vigila a WAHA como proceso hijo:

- Zuki Pay escucha en `$PORT` (lo único público). Cuando ya responde, arranca WAHA en `127.0.0.1:3001` (solo local; además pide `X-Api-Key`).
- Si Zuki Pay se cae, se cae el contenedor y Render lo reinicia. Si WAHA se cae, se reinicia solo WAHA (máx. 5 veces por hora); los cobros siguen.
- Panel y Swagger de WAHA apagados. Historial de chats mínimo, sin descargar fotos/audios, grupos y estados ignorados (menos memoria).
- Memoria (plan 512 MB): medido con la imagen real, sin número vinculado: ≈ 450–470 MB en total (Zuki Pay ~100–115, WAHA ~290, GOWS ~60). Queda poco margen. Si el contenedor pasa de 490 MB (`WAHA_MEM_RESTART_MB`) por más de un rato, se reinicia solo WAHA (máx. 3 por hora) para no tumbar los cobros. Cada ~10 min los logs dicen "[memoria] Contenedor ≈ N MB". Si se vuelve un problema, la salida es mover WAHA a un servicio aparte (USD 7/mes) con `WAHA_EMBEDDED=0` + `WAHA_URL`.

## Vincular el número (desde la app)

1. En el celular del chip: WhatsApp Business con ese número.
2. En Zuki Pay (administrador de la academia o superadministrador): **WhatsApp → Vincular WhatsApp**. Aparece un QR que se renueva solo.
3. En el celular: **Dispositivos vinculados → Vincular un dispositivo** y escanear. Si la app está abierta en ese mismo celular, usar **Vincular con código** (WhatsApp → Vincular con el número de teléfono).
4. El estado cambia a **Conectado**. Mandar un **mensaje de prueba**.

## Reinicios y deploys (la sesión)

La sesión vive en `/app/.sessions`, que en Render sin disco se borra en cada deploy o reinicio. Para no reescanear:

- Si hay Turso (`TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`), la carpeta se respalda **cifrada** (AES-256-GCM, llave derivada de `WAHA_BACKUP_KEY` o, si no hay, de `WAHA_API_KEY`) en las tablas `waha_session_*` de Turso: ~1 min después de conectarse, cada 6 h y al apagar. Al arrancar se restaura antes de iniciar WAHA.
- Las bases SQLite de la sesión se copian con la API de respaldo de SQLite, así que la copia es consistente aunque WAHA esté corriendo.
- Si la copia falla o no existe (o cambia la llave), la app muestra "Falta escanear el código QR"/"Sin vincular" y hay que volver a vincular. Si el contenedor muere de golpe (sin apagado limpio), se usa la última copia (hasta 6 h vieja); normalmente sigue funcionando, pero si WhatsApp la rechaza, se vuelve a vincular.
- Alternativa sin esta copia: disco de Render en `/app/.sessions` (de pago) o PostgreSQL externo con `WHATSAPP_SESSIONS_POSTGRESQL_URL`.

## Variables (servicio de Zuki Pay en Render)

| Variable | Valor sugerido | Para qué |
|---|---|---|
| `WAHA_API_KEY` | una llave larga aleatoria (secreta) | Activa WAHA en el contenedor y protege su API |
| `WAHA_SEND_DELAY_MS` | `30000` | Pausa entre mensajes (20000–60000) |
| `WAHA_MX_PREFIX` | `52` | Probar `521` solo si no llegan a celulares mexicanos |
| `WAHA_LINK_SCHOOL_IDS` | (vacío) | Escuelas cuyo admin puede vincular; vacío = academias de natación |
| `WAHA_BACKUP_KEY` | opcional (secreta) | Llave aparte para cifrar la copia de la sesión |
| `WAHA_URL`, `WAHA_EMBEDDED=0` | no poner | Solo si WAHA se mueve a otro servidor |
| `WAHA_MAX_OLD_SPACE_MB`, `WAHA_MEM_RESTART_MB` | no poner (128 / 490) | Ajuste fino de memoria |

No guarde llaves en el repositorio.

## Números de México (52 / 521)
WhatsApp registra algunos móviles de México como `52XXXXXXXXXX` y otros como `521XXXXXXXXXX`.
Antes de cada envío el servidor consulta `GET /api/contacts/check-exists` (probando 52 y luego 521) y envía al
`chatId` que devuelve WAHA (puede ser `@c.us` o `@lid`). Si ninguno existe, el envío queda en error con el mensaje
«no tiene WhatsApp (se probó con 52 y 521)». Una prueba fallida se puede volver a enviar en la misma hora.
