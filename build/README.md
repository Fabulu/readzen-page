# Build scripts

Small Node.js utilities that generate static assets checked into the repo.
They run offline and have no runtime dependencies beyond a modern Node.js
(18+, ES modules).

## `build-dict-shards.js`

Slices the CC-CEDICT dictionary into per-character JSON shards so the
dictionary view can fetch only the tiny bucket it needs instead of the full
3 MB corpus.

### Input

By default: `C:/programmieren/MergeWorkCbeta/CBETA-Translator/Assets/Dict/cedict_ts.u8`

Override with the `CEDICT_PATH` env var:

```bash
CEDICT_PATH=/path/to/cedict_ts.u8 node build/build-dict-shards.js
```

### Output

- `dict/{char}.json` — one file per unique first character of the traditional
  form. Each file is a JSON array of `{ trad, simp, pinyin, defs }` entries.
- `dict/_index.json` — manifest listing every shard character and a build
  timestamp.

Existing `dict/*.json` files are cleared before each run so deleted entries
don't stick around.

### When to re-run

Only when CC-CEDICT itself is updated. The CEDICT source is checked into the
CBETA-Translator desktop app's `Assets/Dict/` directory; when that file
changes upstream, re-run this script to regenerate the shards and commit
the result.

```bash
node build/build-dict-shards.js
git add dict/
git commit -m "Refresh CC-CEDICT shards"
```
