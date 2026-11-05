# WhatsApp automático con WAHA (sin API de Meta)

Los avisos de Cuitswimmer (y de cualquier escuela que los active) salen por **WAHA**: un WhatsApp Web / Baileys con un número propio. No se usa la API de WhatsApp Business de Meta ni sus tokens.

Hace dos cosas, solo si el administrador las deja **activas**:

1. **Una vez al día**, a la hora elegida (horario de la Ciudad de México), escribe al tutor de cada mensualidad **por vencer** (3 días o menos) o **vencida**. El mensaje lleva el nombre del tutor, el del nadador, el monto y la fecha. El mismo aviso no se repite ese día.
2. **En el momento**, copia los avisos que la app ya manda al tutor: compra, compra rechazada (saldo, límites, tarjeta bloqueada o producto prohibido) y saldo bajo. Hace falta que el tutor tenga teléfono.

Entre cada mensaje el servidor espera unos 30 segundos (entre 20 y 60) para no quemar el número. Si `WAHA_URL` o `WAHA_API_KEY` no están puestos, no se envía nada y el resto de Zuki Pay sigue igual.

El teléfono se edita en **Alumnos → Editar** o en el perfil del nadador (**Tarjeta y perfil**). Son 10 dígitos de México. Si el campo WhatsApp queda vacío, se usa el teléfono.

## Variables (servicio de Zuki Pay en Render)

| Variable | Ejemplo | Para qué |
|---|---|---|
| `WAHA_URL` | `http://waha:3000` o la URL pública de WAHA | Dirección del API de WAHA, sin barra al final |
| `WAHA_API_KEY` | una llave larga que usted elija | La misma llave que en el servicio de WAHA (`X-Api-Key`) |
| `WAHA_SESSION` | `cuitswimmer` | Nombre de la sesión. Si se omite, es `default` |
| `WAHA_DASHBOARD_URL` | `https://waha.su-dominio.com/dashboard` | Enlace que ve la academia para escanear el QR. Si se omite, se arma con `WAHA_URL` + `/dashboard` |
| `WAHA_SEND_DELAY_MS` | `30000` | Pausa entre mensajes. Se acota a 20000–60000. Por defecto 30000 |
| `WAHA_MX_PREFIX` | `52` | Cómo se arma el chat. Por defecto `52` + 10 dígitos (`524431112233@c.us`). Si un mensaje no llega, pruebe `521` (prefijo viejo de móviles que a veces pide Baileys) |

No guarde estas llaves en el repositorio. En Render van en *Environment* del servicio.

## WAHA en Docker (al lado, o como segundo servicio)

Imagen oficial: `devlikeapro/waha`. Motor **NOWEB** (Baileys, estilo WhatsApp Web).

```yaml
services:
  waha:
    image: devlikeapro/waha:latest
    ports:
      - "3001:3000"
    environment:
      WAHA_API_KEY: cambie-esta-llave
      WHATSAPP_DEFAULT_ENGINE: NOWEB
      WAHA_DASHBOARD_USERNAME: admin
      WAHA_DASHBOARD_PASSWORD: cambie-esta-clave
    volumes:
      - waha-sessions:/app/.sessions
volumes:
  waha-sessions:
```

El volumen es obligatorio: ahí queda la sesión después del QR. Si se borra, hay que escanear otra vez.

En **Render** puede ser un segundo Web Service con la misma imagen, disco persistente montado en `/app/.sessions`, y las variables de arriba. Anote la URL pública (con el usuario y la clave del panel) y póngala en `WAHA_DASHBOARD_URL` del servicio de Zuki Pay. `WAHA_URL` puede ser esa misma URL (sin `/dashboard`) si WAHA es accesible desde Zuki Pay. `WAHA_API_KEY` debe coincidir en los dos servicios.

## Vincular el número (una vez)

1. En el chip nuevo, instale WhatsApp y confirme el número. No use el WhatsApp personal de alguien si puede evitarlo.
2. Abra el panel (`WAHA_DASHBOARD_URL`), entre y arranque la sesión `WAHA_SESSION`.
3. Cuando pida el QR: en el celular, WhatsApp → **Ajustes → Dispositivos vinculados → Vincular un dispositivo** y escanée.
4. Espere el estado **WORKING** (en Zuki Pay se ve como **Conectado**).
5. En la academia: **Configuración → WhatsApp**. Active los avisos, elija la hora y, si quiere, **Enviar prueba** a su propio celular.

La escuela puede **pausar** los avisos sin desvincular el QR. La hora solo aplica al recordatorio de mensualidad; las compras salen en cuanto ocurren, con la pausa entre mensajes.

## Qué no hace

No cobra la mensualidad, no habla con Meta y no manda avisos de inventario (esos son para la escuela, no para los papás). Un fallo de WAHA queda en *Últimos envíos* y ese aviso no se reintenta el mismo día; al día siguiente, si sigue vencida, se intenta otra vez.
