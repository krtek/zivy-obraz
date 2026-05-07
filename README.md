# Živý Obraz Dashboard

Vlastní dashboard pro Živý Obraz.

## Požadavky

- **Node.js:** Verze 20
- **Balíčky:** Nainstalujte pomocí `npm install`

---

## Nastavení

### Prostředí

Nastavte následující tajné klíče v GitHub repozitáři (Settings > Secrets and variables > Actions):

- `GOLEMIO_API` - [Golemio API token](https://api.golemio.cz/docs/openapi/)
- `BAKALARI_BASE_URL` - URL instance Bakalářů
- `BAKALARI_USERNAME` - Uživatelské jméno pro API Bakalářů
- `BAKALARI_PASSWORD` - Heslo pro API Bakalářů

### Lokální spuštění

Přihlašovací údaje uložte do souboru `.env.local` (není commitován). Načtěte je do shellu a spusťte skript:

```shell
set -a && source .env.local && set +a

node src/dashboard-sync.mjs --bakalari-base-url="$BAKALARI_BASE_URL" --bakalari-username="$BAKALARI_USERNAME" --bakalari-password="$BAKALARI_PASSWORD" --golemio-token="$GOLEMIO_API" --stop-id-1="$STOP_1" --stop-id-2="$STOP_2" --output="dashboard/dashboard.png"
```

---

## Linky

- [Golemio API dokumentace](https://api.golemio.cz/docs/openapi/)
- [Živý Obraz - Můj účet](https://zivyobraz.eu)
- [Bakaláři API dokumentace](https://api.bakalari.cz/docs/)
- [Bakaláři API endpoints](https://github.com/bakalari-api/bakalari-api-v3/blob/master/endpoints.md)
