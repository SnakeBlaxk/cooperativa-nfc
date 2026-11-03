# Respaldos semanales de la base (Turso)

La base de Zuki Pay vive en memoria en el servidor (Render) y se guarda como una copia completa (comprimida y con sha256) en Turso, usando `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN`.

## Qué hace el respaldo

El flujo `.github/workflows/respaldo-semanal.yml` corre **cada domingo a las 3:00 a. m. (hora de Ciudad de México)** = 09:00 UTC, y también a mano (Actions → "Respaldo semanal de la base (Turso)" → *Run workflow*).

1. Descarga de Turso la copia vigente y verifica su sha256 (`scripts/backup-turso.js`).
2. Genera: `zukipay-<fecha>.db` (SQLite completo), `.json` (todas las tablas), `.sql` (volcado) y `manifest.json` (filas por tabla).
3. Lo **cifra** (AES-256, `openssl`, clave `BACKUP_PASSPHRASE`) porque el repositorio es público y los artefactos los puede descargar cualquier usuario de GitHub.
4. Lo sube como artefacto `respaldo-zukipay-<n>` con **retención de 90 días**. Nunca se guardan datos en el repositorio.

## Secretos necesarios (GitHub → Settings → Secrets and variables → Actions → New repository secret)

| Nombre | Valor |
|---|---|
| `TURSO_DATABASE_URL` | El mismo valor que en Render (Environment) |
| `TURSO_AUTH_TOKEN` | El mismo valor que en Render (o un token nuevo de solo lectura: `turso db tokens create <base> --read-only`) |
| `BACKUP_PASSPHRASE` | Una frase larga que usted invente. **Guárdela en un lugar seguro**: sin ella no se puede abrir ningún respaldo. |

## Descargar y abrir un respaldo

1. GitHub → Actions → la ejecución → *Artifacts* → descargar `respaldo-zukipay-<n>` (zip).
2. Descomprimir el zip y descifrar:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in respaldo-zukipay.tar.gz.enc -out respaldo.tar.gz
# (pide la frase BACKUP_PASSPHRASE)
mkdir respaldo && tar xzf respaldo.tar.gz -C respaldo
```

## Restaurar

1. En Render, **suspenda** el servicio (Suspend). Si sigue encendido, sobrescribirá Turso con su base en memoria.
2. En una computadora con el repositorio y `npm ci`:

```bash
export TURSO_DATABASE_URL=...   # token con permiso de escritura
export TURSO_AUTH_TOKEN=...
node scripts/restore-turso.js respaldo/zukipay-<fecha>.db        # solo valida
node scripts/restore-turso.js respaldo/zukipay-<fecha>.db --si   # sube la copia
```

3. En Render, **reanude** el servicio (Resume). Al arrancar descarga la copia restaurada.

La copia que había antes no se borra: queda como generación anterior (`prev_gen`) en Turso.

## Probar

Ejecute el flujo a mano una vez después de agregar los secretos y revise que el artefacto aparezca.
