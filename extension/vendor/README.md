# Mozilla Readability

`Readability.js` is the unmodified Mozilla Readability 0.6.0 browser source from
https://github.com/mozilla/readability/tree/0.6.0, bundled locally so page scans
require no CDN requests. Its Apache 2.0 license is included in `LICENSE.md`.

`article.js` runs it only on a cloned document. Clone-only marker spans retain
provenance to original Text nodes; source pages are never rewritten for extraction.
