# Loading English paragraphs on the production server

One-time task: load ~500,000 English Wikipedia paragraphs with ready-made bge-m3 vectors
(files 000-004 of [Upstash/wikipedia-2024-06-bge-m3](https://huggingface.co/datasets/Upstash/wikipedia-2024-06-bge-m3))
into MariaDB, for the paragraph search in `/api/factcheck/`.

Nothing does this automatically. Until it is done, the backend works as before: the paragraph
search skips the missing `chunk_vector` table.

Run every command from the repository root on the server.

## 1. Check before starting

```bash
# The code with wikirag/upstash.py is deployed (prints "ok"):
docker compose -f docker-compose.prod.yml exec backend python -c "import wikirag.upstash; print('ok')"

# MariaDB runs with the cache settings from docker-compose.prod.yml (expect 1073741824 twice).
# If not, deploy/restart mariadb FIRST: restarting it during the load breaks the load.
docker compose -f docker-compose.prod.yml exec mariadb sh -c \
  'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" -N -e "SELECT @@mhnsw_max_cache_size, @@innodb_buffer_pool_size"'

# Ollama has bge-m3 (needed for searching, not for loading):
docker compose -f docker-compose.prod.yml exec ollama ollama list | grep bge-m3 \
  || docker compose -f docker-compose.prod.yml exec ollama ollama pull bge-m3

# At least 7 GB free: the data takes ~5.5 GB, plus one 440 MB download at a time.
df -h /var/lib/docker
```

## 2. Start the load

Use `docker compose run`, not `exec`: a deploy (push to main) recreates the backend
container and would kill a loader started with `exec`. A `run` container is left alone.

```bash
docker compose -f docker-compose.prod.yml run -d --name wikirag-load \
  -e RAG_DATA_DIR=/tmp/wikirag backend python -m wikirag.upstash
```

`RAG_DATA_DIR=/tmp/wikirag` is required: in production `/data/wikirag` is mounted read-only.

Expected time: 45-90 minutes. Each file is downloaded (~440 MB), loaded, then deleted. Inserts
slow down as the vector index grows, sharply once it outgrows the 1 GB cache (on a laptop with
NVMe: 3, 5, 7, 9 and 21 minutes for the five files, 45 minutes in all). A slow last file is
expected, not a hang: `docker logs` keeps counting paragraphs.

## 3. Watch it

```bash
docker logs -f wikirag-load
```

Done when the log ends with `chunk: 500,000 paragraphs from 12,637 articles` and the
container has exited (`docker ps -a --filter name=wikirag-load`).

## 4. Verify and clean up

```bash
# Expect: 500000 and 12637
docker compose -f docker-compose.prod.yml exec mariadb sh -c \
  'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE" -N -e "SELECT COUNT(*), COUNT(DISTINCT page_id) FROM chunk"'

# A search should return the Aristotle article first, distance ~0.31:
docker compose -f docker-compose.prod.yml exec backend \
  python -m wikirag --chunks --excerpt --limit 3 "Aristotle was a student of Plato"

docker rm wikirag-load
```

## If it is interrupted

Remove the container and start the same command again (step 2). Finished files are recorded in
the `loaded_file` table and skipped; the file that was in progress starts over, and rows it had
already inserted are skipped, so nothing is duplicated.

```bash
docker rm -f wikirag-load
```

## Do not

- Do not restart or redeploy `mariadb` while the load runs.
- Do not run `docker volume prune`, `docker system prune --volumes` or remove the
  `wikirag-db` volume: it holds all the Wikipedia data.
- Do not load more files (`--files 5-…`) without checking RAM and disk first: each extra file
  adds ~100,000 paragraphs and ~0.9 GB.
