-- Tables for Wikipedia RAG search on MariaDB Vector (MariaDB 11.7 or later).
-- Same schema as https://github.com/MariaDB/mariadb-vector-wikipedia-rag (schema.sql).
-- Applied by:  python -m wikirag.load

CREATE TABLE IF NOT EXISTS article (
  lang          CHAR(2)      NOT NULL,      -- fi, en, sv
  page_id       INT UNSIGNED NOT NULL,      -- Wikipedia's own id, per language
  rev_id        INT UNSIGNED NOT NULL,      -- the version we have
  wikidata_id   VARCHAR(20),                -- same topic across languages, e.g. Q33 = Finland
  title         VARCHAR(255) NOT NULL,
  url           VARCHAR(500) NOT NULL,
  date_modified DATETIME,                   -- when this version was saved
  text          MEDIUMTEXT   NOT NULL,      -- clean Markdown from FineWiki
  PRIMARY KEY (lang, page_id),
  KEY (wikidata_id),
  FULLTEXT (title, text)
) CHARACTER SET utf8mb4;

-- A vector exists only once it is computed: a VECTOR INDEX column must be NOT NULL.
CREATE TABLE IF NOT EXISTS article_vector (
  lang       CHAR(2)      NOT NULL,
  page_id    INT UNSIGNED NOT NULL,
  model      VARCHAR(50)  NOT NULL,         -- which model made this vector
  truncated  BOOL         NOT NULL,         -- article was longer than the model reads
  embedding  VECTOR(1024) NOT NULL,
  PRIMARY KEY (lang, page_id),
  -- M=16 instead of the default 6: with 1024 dimensions, M=6 found only 79% of the true top 10.
  VECTOR INDEX (embedding) M=16 DISTANCE=cosine
);

-- The category tree under "Suomen historia" (Finnish category names, without "Luokka:").
CREATE TABLE IF NOT EXISTS category_link (
  parent  VARCHAR(255) NOT NULL,
  child   VARCHAR(255) NOT NULL,
  PRIMARY KEY (parent, child),
  KEY (child)
) CHARACTER SET utf8mb4;

-- Which categories each article is in. Swedish and English articles get the categories of the
-- Finnish article on the same topic (same wikidata_id).
CREATE TABLE IF NOT EXISTS article_category (
  lang      CHAR(2)      NOT NULL,
  page_id   INT UNSIGNED NOT NULL,
  category  VARCHAR(255) NOT NULL,
  PRIMARY KEY (lang, page_id, category),
  KEY (category)
) CHARACTER SET utf8mb4;

-- Paragraphs with ready-made bge-m3 vectors, from Upstash/wikipedia-2024-06-bge-m3 (English,
-- June 2024). Loaded by: python -m wikirag.upstash. One vector per paragraph finds single facts
-- that one vector per article (article_vector) misses in long articles.
CREATE TABLE IF NOT EXISTS chunk (
  lang     CHAR(2)           NOT NULL,
  page_id  INT UNSIGNED      NOT NULL,      -- Wikipedia's own id, per language
  seq      SMALLINT UNSIGNED NOT NULL,      -- paragraph number within the article
  title    VARCHAR(255)      NOT NULL,
  url      VARCHAR(500)      NOT NULL,
  text     MEDIUMTEXT        NOT NULL,
  PRIMARY KEY (lang, page_id, seq)
) CHARACTER SET utf8mb4;

-- Kept apart from chunk for the same reason as article_vector: the vector search must run on
-- this table alone for MariaDB to use the index.
CREATE TABLE IF NOT EXISTS chunk_vector (
  lang       CHAR(2)           NOT NULL,
  page_id    INT UNSIGNED      NOT NULL,
  seq        SMALLINT UNSIGNED NOT NULL,
  embedding  VECTOR(1024)      NOT NULL,
  PRIMARY KEY (lang, page_id, seq),
  VECTOR INDEX (embedding) M=16 DISTANCE=cosine
);

-- Source files already loaded into chunk, so an interrupted load resumes where it stopped.
CREATE TABLE IF NOT EXISTS loaded_file (
  name       VARCHAR(255) NOT NULL PRIMARY KEY,
  row_count  INT UNSIGNED NOT NULL,
  loaded_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
);
