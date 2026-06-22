# Deploy Wasabi onto the n8n VPS (shares the existing Caddy)

The n8n box already runs Caddy on 80/443. Wasabi does **not** get its own proxy —
it joins n8n's network and n8n's Caddy serves it at `wasabi.sanjow-hub.com`.

**Box:** `79.143.191.47` · **n8n stack:** `/opt/n8n-stack` · **Wasabi goes in:** `/opt/wasabi`

---

## 0. DNS (do this first — cert issuance needs it)
Add an **A record**: `wasabi.sanjow-hub.com` → `79.143.191.47` (wherever `sanjow-hub.com` DNS lives). Give it a few minutes.

## 1. SSH in
```bash
ssh root@79.143.191.47
```

## 2. Get the code (public repo — no auth)
```bash
git clone https://github.com/GambitIsHere/wasabi.git /opt/wasabi
cd /opt/wasabi/deploy
```

## 3. Confirm the n8n network name
```bash
docker network ls | grep internal      # expect: n8n-stack_internal
```
If it's NOT `n8n-stack_internal`, edit `docker-compose.vps.yml` → `networks.n8n.name` to match.

## 4. Wasabi env (the Metabase read-only key, host-only)
```bash
cat > .env <<'EOF'
METABASE_URL=https://metabase.paynova.app
METABASE_API_KEY=PASTE_THE_READ_ONLY_KEY_HERE
GENERIC_TIMEZONE=Europe/Lisbon
EOF
```

## 5. Build + start Wasabi (no ports exposed; only Caddy reaches it)
```bash
docker compose -f docker-compose.vps.yml up -d --build
docker ps --filter name=wasabi          # should be Up
```
> The build runs `next build` on the box (~1–2 GB RAM for a minute). If the VPS is tight, watch `docker logs wasabi`.

## 6. Add the Wasabi site to n8n's Caddy
Generate an admin password hash:
```bash
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'CHOOSE_A_PASSWORD'
```
Append this block to `/opt/n8n-stack/Caddyfile` (paste the hash where shown):
```caddy
wasabi.sanjow-hub.com {
	encode zstd gzip
	# Storefronts call these — must stay public (no auth).
	@public path /api/decide /api/decide/* /api/capture /api/capture/*
	handle @public {
		reverse_proxy wasabi:3000
	}
	# Admin UI — protected.
	handle {
		basic_auth {
			admin PASTE_THE_HASH_HERE
		}
		reverse_proxy wasabi:3000
	}
}
```
Reload Caddy (no downtime):
```bash
docker compose -f /opt/n8n-stack/docker-compose.yml exec caddy caddy reload --config /etc/caddy/Caddyfile
```

## 7. Open it
`https://wasabi.sanjow-hub.com` → log in (admin + your password). The seeded
experiments are there, including **AC-AB-002 (paused)**. Verify the config, hit **Activate**.

---

### Backups
The only state is the `wasabi-data` volume:
```bash
docker run --rm -v wasabi-data:/d -v /opt/wasabi:/b alpine cp /d/wasabi.db /b/wasabi-backup-$(date +%F).db
```

### Updating later
```bash
cd /opt/wasabi && git pull && cd deploy && docker compose -f docker-compose.vps.yml up -d --build
```
