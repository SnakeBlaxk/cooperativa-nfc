# Integración con lectores y tarjetas NFC

La app ya funciona con lectores reales: el punto de venta solo necesita **el UID de la tarjeta**. Este documento explica qué tarjetas comprar, qué lectores usar y cómo se conectan.

## 1. Enfoque: solo UID en la tarjeta, saldo en la base de datos

- La tarjeta funciona como **identificador**. El **saldo, límites y prohibiciones viven en la base de datos** (en el servidor), nunca en la tarjeta.
- Ventajas: si la tarjeta se pierde, se reporta y el saldo se transfiere a otra; no se puede “recargar” la tarjeta con un teléfono; no hay que escribir datos en cada venta (más rápido y sin tarjetas corruptas).
- La app normaliza el UID: quita `:`, `-` y espacios y lo pasa a mayúsculas (`04:a1:b2…` → `04A1B2…`).

## 2. Tipo de tarjeta recomendado

| Tarjeta | UID | Precio aprox. (lote 200) | Comentario |
|---|---|---|---|
| **NTAG213 / NTAG215** (ISO 14443A, NFC Forum Tipo 2) | 7 bytes | $8–15 MXN c/u | **Recomendada para empezar.** Compatible con todos los lectores, con teléfonos Android (Web NFC) y iPhone. |
| MIFARE Classic 1K | 4 bytes (a veces no único) | $8–12 MXN | Funciona, pero su cifrado (Crypto1) está roto y algunos teléfonos no la leen. |
| **NTAG424 DNA** | 7 bytes + SUN/SDM | $25–45 MXN | **Recomendada si se quiere autenticación fuerte** (ver seguridad). |

Pida tarjetas tipo **PVC tamaño credencial (CR80)** para poder imprimir nombre/foto del alumno después (impresora de credenciales o etiqueta).

### Seguridad: los UID se pueden clonar
El UID de NTAG213/215 y MIFARE Classic **puede copiarse** a una tarjeta “mágica” o emularse con un teléfono. Mitigaciones en la app: el cajero ve **nombre y foto** del alumno al leer la tarjeta, límites diarios/por compra, historial visible para los padres y bloqueo inmediato. Para mayor seguridad, migrar a **NTAG424 DNA**: genera un código criptográfico (AES-128, SUN/SDM) distinto en cada lectura que el sistema valida, por lo que una copia del UID no sirve. Requiere guardar la clave de cada tarjeta y validar el mensaje en el servidor (ver `PENDIENTES.md`).

## 3. Lectores

### Opción A — Lector USB que emula teclado (la más sencilla) ✅
- Lectores de 13.56 MHz “USB HID keyboard” (p. ej. modelos genéricos 125 kHz/13.56 MHz, *Sycreader*, *Yarongtech*, etc.; **$250–600 MXN**). Verifique que sean **13.56 MHz / ISO 14443A** (no solo 125 kHz) y que permitan configurar **formato hexadecimal** y **Enter al final**.
- No requiere drivers ni configuración: al acercar la tarjeta “escribe” el UID y presiona Enter.
- **En la app**: el campo UID del punto de venta, recargas y tarjetas tiene foco automático y procesa con Enter. Además, si el foco no está en un campo de texto, la app detecta la “ráfaga” rápida de teclas del lector y la toma como UID (`listenCardReader` en `src/renderer/app.js`).
- Cuidado: algunos lectores envían el UID en **decimal** o con los bytes invertidos. Configure el lector en hexadecimal; si no se puede, registre las tarjetas con el mismo lector que usará la caja (la app compara exactamente el texto leído).

### Opción B — ACR122U (u otro PC/SC) con `nfc-pcsc` en el proceso principal de Electron
Lector de escritorio muy común (**$600–900 MXN**). Lee el UID real vía PC/SC, sin depender del foco del teclado. La app ya trae la integración en `src/main/nfc.js`; solo falta instalar la librería nativa:

```bash
# Windows: no requiere nada más (el servicio "Tarjeta inteligente" viene con Windows)
# macOS: no requiere nada más
# Linux: sudo apt install pcscd libpcsclite-dev && sudo systemctl enable --now pcscd
npm install nfc-pcsc
npx electron-builder install-app-deps   # recompila el módulo nativo para la versión de Electron
npm start
```
Para el instalador, compile **en cada sistema operativo** (el módulo nativo se compila para la plataforma donde se ejecuta `npm run dist:*`). En Windows se necesitan *Visual Studio Build Tools* (C++) y Python; en macOS, Xcode Command Line Tools.

Cómo está conectado (ya incluido):

```js
// src/main/nfc.js (proceso principal)
const { NFC } = require('nfc-pcsc');
const nfc = new NFC();
nfc.on('reader', (reader) => {
  reader.autoProcessing = true;
  reader.on('card', (card) => onUid(String(card.uid).toUpperCase()));
});

// src/main/main.js — envía el UID a la ventana por IPC
startNfcReader((uid) => mainWindow.webContents.send('nfc:uid', uid),
               (status) => mainWindow.webContents.send('nfc:status', status));

// src/main/preload.js — puente seguro
onNfcUid: (cb) => { const h = (_e, uid) => cb(uid); ipcRenderer.on('nfc:uid', h); return () => ipcRenderer.removeListener('nfc:uid', h); },

// src/renderer/app.js — el punto de venta / recargas / tarjetas reciben el UID
const off = window.coop.onNfcUid((uid) => lookup(uid));
```
El estado del lector aparece arriba a la derecha del punto de venta (“Lector conectado: ACS ACR122U…”). Si `nfc-pcsc` no está instalado, la app sigue en modo teclado USB.

Para probar el lector sin la app: `node examples/probar-lector-pcsc.js`.

Nota ACR122U: por defecto pita y enciende LED en cada lectura; en Linux puede requerir desactivar el módulo del kernel `pn533_usb` (`sudo modprobe -r pn533_usb pn533 nfc` y agregarlo a la lista negra).

### Opción C — Teléfono Android con Web NFC (solo en la PWA del servidor)
Chrome para Android (versión 89+) con HTTPS puede leer el número de serie de la tarjeta. En la PWA, el punto de venta muestra el botón **“Leer con NFC del teléfono”**:

```js
const reader = new NDEFReader();
await reader.scan();                      // requiere un toque del usuario y HTTPS
reader.onreading = (e) => {
  const uid = e.serialNumber.replace(/:/g, '').toUpperCase();
  lookup(uid);
};
```
Limitaciones: no funciona en iPhone ni en Chrome de escritorio; la pantalla debe estar encendida y la página en primer plano. Útil como respaldo o para recargas con un celular.

## 4. Operación

- **Internet**: desde la versión 2.0 **todo requiere internet** (caja de escritorio, tableta y celular usan el servidor en línea). Sin conexión se muestra “Sin conexión a internet. No se puede cobrar hasta que regrese la conexión.” y no se cobra.
- **Lector USB tipo teclado (125 kHz o NFC)**: funciona igual en la caja de escritorio, en el navegador y en tabletas con USB/OTG: el campo de la tarjeta tiene el foco automático y el lector “escribe” el UID y Enter. **PC/SC (ACR122U)**: solo en la caja de escritorio; el UID llega a la página por el puente seguro `window.coopDesktop`.
- **Sin conexión con servidor configurado**: el admin/cajero puede entrar con la última contraseña válida guardada localmente.
- **Respaldos**: *Ajustes → Crear respaldo…* guarda una copia de `cooperativa.db`. Hágalo diario (USB o nube). Para restaurar: cerrar la app y reemplazar el archivo por el respaldo con el nombre `cooperativa.db`. En el servidor, copiar `DB_PATH` diario con un cron.
- **Corte de luz**: cada venta se guarda en disco al confirmarse (escritura atómica), por lo que una venta confirmada no se pierde. Se recomienda un **no-break (UPS)** para la computadora de la caja.
- **Registro de las 200 tarjetas**: *Tarjetas → Registrar*: haga clic en el campo UID, acerque cada tarjeta y presione Registrar (quedan “sin asignar”). Después asígnelas a cada alumno, o registre y asigne en un paso. En la PWA genere el **código de invitación** del alumno y entréguelo impreso con la tarjeta.

## 5. Privacidad de datos de menores (México)

La app trata datos personales de menores (nombre, grado, foto, hábitos de consumo) y de sus tutores (nombre, teléfono, correo). Conforme a la **Ley Federal de Protección de Datos Personales en Posesión de los Particulares (LFPDPPP)**:

- Publicar y entregar un **Aviso de Privacidad** (integral y simplificado) antes de recabar datos: responsable (Zuki Company / cooperativa), datos que se recaban, finalidades (control de saldo y consumo), transferencias (ninguna, o el proveedor de hosting), medios para ejercer **derechos ARCO** y revocar el consentimiento.
- Obtener el **consentimiento del padre, madre o tutor** (por escrito o en el registro de la PWA) — la foto es opcional.
- Recabar solo lo necesario; no usar los datos de consumo para fines comerciales sin consentimiento.
- Medidas de seguridad: contraseñas cifradas (bcrypt), acceso por roles, respaldos cifrados o en lugar seguro, equipo de la caja con contraseña de Windows/macOS y cifrado de disco (BitLocker/FileVault), HTTPS en el servidor.
- Definir plazo de conservación (p. ej. borrar o anonimizar al terminar el ciclo escolar o al dar de baja al alumno).

## 6. Próximos pasos
Ver `PENDIENTES.md`: recargas en línea, notificaciones a padres, app móvil, NTAG424 DNA, etc.

## Programar muchas tarjetas a la vez (multi-escuela)

En la caja (administrador): **Programar tarjetas**.
1. **Leer tarjetas**: acerque las tarjetas al lector una tras otra (sirve el lector USB tipo teclado o el PC/SC). Cada UID nuevo se registra como *sin asignar*; si ya existía se avisa en rojo y no se duplica.
2. **Asignar a alumnos**: la lista de alumnos sin tarjeta (por grado y nombre) propone las tarjetas en el orden en que se leyeron; también puede tocar **Leer** junto a un alumno y acercar su tarjeta.
3. **Hoja de códigos**: genera un PDF/impresión con un recuadro por alumno (tarjeta + código de invitación del padre).

Los **UID son únicos en toda la plataforma**: una tarjeta registrada en una escuela no puede usarse en otra (el servidor responde “Esa tarjeta (UID) ya está registrada en otra escuela”).
